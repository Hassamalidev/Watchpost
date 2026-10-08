/*
 * P3-T04 and P3-T09 AC against the real database: credits exist only after a collected payment, every
 * change is an idempotent ledger entry and the balance equals the ledger exactly, charges refuse when
 * there are not enough credits (also under concurrency), false alarms refund once, annual plans get a
 * grant every month, AI spend is capped by what was paid for, and the provider balance check warns the
 * owner when it can't cover what customers have paid for.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import request from "supertest";
import { createFakeClock } from "../../../core/clock.js";
import { createWorkspaceScope, type WorkspaceScope } from "../../../core/workspace-scope.js";
import { CREDIT_PROVIDER_COST_MICROS, PLANS } from "../../../config/plans.js";
import type { ProviderBalanceReader } from "../../../infra/funding/index.js";
import { newId } from "../../../infra/ids.js";
import {
  billingEmails,
  buildBillingApp,
  deliverAndProcess,
  eventsOf,
  fakePaddleApi,
  get,
  paddleEvent,
  post,
  PRICES,
  signUpWithWorkspace,
  subscribeWorkspace,
  subscriptionPayload,
  type BillingApp,
} from "../../../__tests__/helpers/billing.js";
import { createCreditsRepository } from "../credits.repository.js";
import { createCreditsService, type CreditsService } from "../credits.service.js";
import { createCreditsEventHandlers } from "../events/index.js";

const DAY = 86_400_000;
const clock = createFakeClock(new Date());
const paddle = fakePaddleApi(clock);
const repo = createCreditsRepository();
let ctx: BillingApp;
let credits: CreditsService;

type Owner = Awaited<ReturnType<typeof signUpWithWorkspace>>;
const scopeOf = (o: Owner): WorkspaceScope => createWorkspaceScope({ workspaceId: o.workspaceId });

/* The balance row must equal the sum of the ledger, bucket by bucket. */
async function expectReconciled(o: Owner) {
  const scope = scopeOf(o);
  const row = await repo.balance(ctx.container.infra.db, scope);
  const totals = await repo.ledgerTotals(ctx.container.infra.db, scope);
  expect({ included: row?.included ?? 0, purchased: row?.purchased ?? 0 }).toEqual(totals);
}

const meta = (workspaceId: string) => ({
  eventId: newId(),
  workspaceId,
  correlationId: null,
  occurredAt: new Date(),
  logger: ctx.container.infra.logger,
});

/* A credits service like the container's, with chosen provider balances and AI settings. */
function serviceWith(options: {
  readers?: ProviderBalanceReader[];
  funding?: Partial<{ aiEnabled: boolean; unfundedAiCapMicros: number; opsEmail: string }>;
}) {
  const { infra } = ctx.container;
  return createCreditsService({
    db: infra.db,
    repository: repo,
    billing: ctx.billing.service,
    outbox: infra.outbox,
    clock,
    logger: infra.logger,
    newId,
    locks: infra.locks,
    funding: {
      aiEnabled: true,
      unfundedAiCapMicros: 5_000_000,
      opsEmail: undefined,
      ...options.funding,
    },
    balanceReaders: options.readers ?? [],
  });
}

beforeAll(() => {
  ctx = buildBillingApp(clock, paddle);
  credits = ctx.credits.service;
});

afterAll(async () => {
  await ctx.container.close();
});

describe("credits follow collected payments", () => {
  it("gives a trial workspace no credits and refuses to charge", async () => {
    const o = await signUpWithWorkspace(ctx, "cr-trial");
    expect((await ctx.billing.service.entitlements(scopeOf(o))).plan).toBe("pro");
    expect(await credits.grantDue(o.workspaceId)).toBe(0);
    expect(await credits.state(scopeOf(o))).toMatchObject({
      included: 0,
      purchased: 0,
      total: 0,
      monthlyAllowance: 0,
      lowBalance: false,
      recent: [],
    });
    expect(await credits.charge(scopeOf(o), { credits: 1, refId: "d-1" })).toEqual({
      ok: false,
      balance: 0,
    });
  });

  it("grants nothing for a subscription whose payment was not collected", async () => {
    const o = await signUpWithWorkspace(ctx, "cr-unpaid");
    await subscribeWorkspace(ctx, paddle, clock, o, {
      priceId: PRICES.proMonth,
      plan: "pro",
      paid: false,
    });
    expect((await ctx.billing.service.entitlements(scopeOf(o))).source).toBe("subscription");
    expect(await credits.grantDue(o.workspaceId)).toBe(0);
    expect((await credits.state(scopeOf(o))).total).toBe(0);
  });

  it("grants the month's credits once when the period is paid, and funds the providers", async () => {
    const o = await signUpWithWorkspace(ctx, "cr-paid");
    await subscribeWorkspace(ctx, paddle, clock, o, {
      priceId: PRICES.starterMonth,
      plan: "starter",
    });
    expect(await eventsOf(ctx, o.workspaceId, "billing.period_renewed")).toHaveLength(1);

    const handlers = createCreditsEventHandlers(credits);
    const renewed = handlers["billing.period_renewed"];
    if (renewed === undefined) throw new Error("no handler");
    const payload = { subscriptionId: newId(), periodEnd: clock.now().toISOString() };
    await renewed(payload, meta(o.workspaceId));
    await renewed(payload, meta(o.workspaceId));

    const state = await credits.state(scopeOf(o));
    expect(state).toMatchObject({ included: 25, purchased: 0, total: 25, monthlyAllowance: 25 });
    expect(state.recent.map((e) => [e.reason, e.delta, e.balanceAfter])).toEqual([
      ["grant", 25, 25],
    ]);
    await expectReconciled(o);

    const funding = await ctx.container.infra.db.execute<{
      provider: string;
      amount_micros: string;
    }>(sql`select provider, amount_micros from provider_funding
           where workspace_id = ${o.workspaceId} order by provider`);
    expect(funding.rows.map((r) => [r.provider, Number(r.amount_micros)])).toEqual([
      ["anthropic", PLANS.starter.aiBudgetMicros],
      ["twilio", 25 * CREDIT_PROVIDER_COST_MICROS],
    ]);
  });
});

describe("charging, packs, refunds", () => {
  let o: Owner;
  let scope: WorkspaceScope;
  const incidentId = newId();

  beforeAll(async () => {
    o = await signUpWithWorkspace(ctx, "cr-use");
    scope = scopeOf(o);
    await subscribeWorkspace(ctx, paddle, clock, o, {
      priceId: PRICES.starterMonth,
      plan: "starter",
    });
    await credits.grantDue(o.workspaceId);
  });

  it("charges once per reference and refuses more than the balance", async () => {
    expect(await credits.charge(scope, { credits: 3, refId: "delivery-1", incidentId })).toEqual({
      ok: true,
      alreadyCharged: false,
      remaining: 22,
    });
    expect(await credits.charge(scope, { credits: 3, refId: "delivery-1", incidentId })).toEqual({
      ok: true,
      alreadyCharged: true,
      remaining: 22,
    });
    expect(await credits.charge(scope, { credits: 23, refId: "delivery-2" })).toEqual({
      ok: false,
      balance: 22,
    });
    await expect(credits.charge(scope, { credits: 0, refId: "x" })).rejects.toThrow();
    await expect(credits.charge(scope, { credits: 1.5, refId: "x" })).rejects.toThrow();
    expect((await credits.state(scope)).total).toBe(22);
    await expectReconciled(o);
  });

  it("adds a paid credit pack once and spends included credits first", async () => {
    const handlers = createCreditsEventHandlers(credits);
    const purchased = handlers["billing.credits_purchased"];
    if (purchased === undefined) throw new Error("no handler");
    const payload = { transactionId: `txn_${newId()}`, credits: 100 };
    await purchased(payload, meta(o.workspaceId));
    await purchased(payload, meta(o.workspaceId));
    expect(await credits.state(scope)).toMatchObject({ included: 22, purchased: 100, total: 122 });

    expect(await credits.charge(scope, { credits: 30, refId: "delivery-3" })).toMatchObject({
      ok: true,
      remaining: 92,
    });
    const state = await credits.state(scope);
    expect(state).toMatchObject({ included: 0, purchased: 92 });
    const charge = state.recent.filter((e) => e.reason === "charge").slice(0, 2);
    expect(charge.map((e) => [e.bucket, e.delta]).sort()).toEqual([
      ["included", -22],
      ["purchased", -8],
    ]);
    await expectReconciled(o);
  });

  it("refunds a false alarm's credits once", async () => {
    expect(await credits.refundIncident(scope, incidentId)).toBe(3);
    expect(await credits.state(scope)).toMatchObject({ included: 3, purchased: 92, total: 95 });
    expect(await credits.refundIncident(scope, incidentId)).toBe(0);
    expect((await credits.state(scope)).total).toBe(95);
    expect(await credits.refundIncident(scope, newId())).toBe(0);
    await expectReconciled(o);
  });

  it("never lets parallel charges spend more than the balance", async () => {
    const before = (await credits.state(scope)).total;
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        credits.charge(scope, { credits: 10, refId: `parallel-${i}` }),
      ),
    );
    const ok = results.filter((r) => r.ok).length;
    expect(ok).toBe(Math.floor(before / 10));
    expect((await credits.state(scope)).total).toBe(before - ok * 10);
    await expectReconciled(o);
  });

  it("warns billing contacts once when credits run low", async () => {
    expect(await billingEmails(ctx, o.workspaceId, "credits_low")).toHaveLength(0);
    const total = (await credits.state(scope)).total;
    expect(total).toBe(5);
    await credits.charge(scope, { credits: 1, refId: "low-1" });
    await credits.charge(scope, { credits: 1, refId: "low-2" });
    const emails = await billingEmails(ctx, o.workspaceId, "credits_low");
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ to: o.email, data: { credits: 4 } });
    expect((await credits.state(scope)).lowBalance).toBe(true);
    /* A new pack clears the warning, so the next shortage is announced again. */
    await credits.addPurchased(o.workspaceId, `txn_${newId()}`, 100);
    expect((await credits.state(scope)).lowBalance).toBe(false);
  });

  it("serves the balance to members only", async () => {
    const res = await get(o.agent, `/api/w/${o.workspaceId}/credits`);
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ purchased: 103, monthlyAllowance: 25 });
    expect((await request(ctx.app).get(`/api/w/${o.workspaceId}/credits`)).status).toBe(401);
    const stranger = await signUpWithWorkspace(ctx, "cr-stranger");
    expect((await get(stranger.agent, `/api/w/${o.workspaceId}/credits`)).status).toBe(404);
  });
});

describe("plan changes and months", () => {
  it("tops the allowance up when the plan is upgraded inside a paid month", async () => {
    const o = await signUpWithWorkspace(ctx, "cr-upgrade");
    const data = await subscribeWorkspace(ctx, paddle, clock, o, {
      priceId: PRICES.starterMonth,
      plan: "starter",
    });
    await credits.grantDue(o.workspaceId);
    await credits.charge(scopeOf(o), { credits: 5, refId: "before-upgrade" });

    clock.advance(60_000);
    const upgraded = await post(o.agent, `/api/w/${o.workspaceId}/billing/plan`, { plan: "pro" });
    expect(upgraded.status, upgraded.text).toBe(200);
    const handler = createCreditsEventHandlers(credits)["billing.plan_changed"];
    if (handler === undefined) throw new Error("no handler");
    await handler({ from: "starter", to: "pro" }, meta(o.workspaceId));
    await handler({ from: "starter", to: "pro" }, meta(o.workspaceId));

    expect(await credits.state(scopeOf(o))).toMatchObject({ included: 145, monthlyAllowance: 150 });
    await expectReconciled(o);
    const funding = await ctx.container.infra.db.execute<{ amount_micros: string }>(
      sql`select amount_micros from provider_funding
          where workspace_id = ${o.workspaceId} and provider = 'twilio'`,
    );
    expect(funding.rows.map((r) => Number(r.amount_micros))).toEqual([
      150 * CREDIT_PROVIDER_COST_MICROS,
    ]);
    expect(data.id).toBeTruthy();
  });

  it("grants an annual plan every month, expires the old month and keeps purchased credits", async () => {
    const o = await signUpWithWorkspace(ctx, "cr-annual");
    const scope = scopeOf(o);
    await subscribeWorkspace(ctx, paddle, clock, o, {
      priceId: PRICES.proYear,
      plan: "pro",
      interval: "year",
      days: 365,
    });
    expect(await credits.grantDue(o.workspaceId)).toBe(150);
    await credits.addPurchased(o.workspaceId, `txn_${newId()}`, 100);
    await credits.charge(scope, { credits: 40, refId: "month-1" });
    expect(await credits.state(scope)).toMatchObject({ included: 110, purchased: 100 });

    /* Nothing new inside the same month. */
    clock.advance(10 * DAY);
    await credits.grantSweep();
    expect((await credits.state(scope)).included).toBe(110);

    clock.advance(25 * DAY);
    /* The old month is over; what is left of it stays usable until the new grant replaces it. */
    expect(await credits.state(scope)).toMatchObject({ included: 110, purchased: 100 });
    expect(await credits.grantSweep()).toBeGreaterThanOrEqual(1);
    await credits.grantSweep();
    const state = await credits.state(scope);
    expect(state).toMatchObject({ included: 150, purchased: 100, total: 250 });
    expect(
      state.recent
        .slice(0, 2)
        .map((e) => [e.reason, e.delta])
        .sort(),
    ).toEqual([
      ["expire", -110],
      ["grant", 150],
    ]);
    await expectReconciled(o);
  });

  it("stops granting when the paid period ends without a renewal", async () => {
    const o = await signUpWithWorkspace(ctx, "cr-lapsed");
    const scope = scopeOf(o);
    const data = await subscribeWorkspace(ctx, paddle, clock, o, {
      priceId: PRICES.proMonth,
      plan: "pro",
    });
    expect(await credits.grantDue(o.workspaceId)).toBe(150);

    /* Paddle rolls the period forward, but the renewal payment never arrives. */
    clock.advance(31 * DAY);
    const rolled = {
      ...data,
      periodStart: new Date(clock.now().getTime() - DAY),
      periodEnd: new Date(clock.now().getTime() + 29 * DAY),
      updatedAt: clock.now(),
    };
    await deliverAndProcess(
      ctx,
      paddleEvent("subscription.updated", subscriptionPayload(rolled), clock.now()),
    );
    expect(await credits.grantDue(o.workspaceId)).toBe(0);
    /* No new allowance, but what was left of the paid month still sends alerts for a week. */
    expect(await credits.state(scope)).toMatchObject({
      included: 150,
      total: 150,
      monthlyAllowance: 0,
    });
    expect(await credits.charge(scope, { credits: 1, refId: "in-grace" })).toMatchObject({
      ok: true,
      remaining: 149,
    });

    clock.advance(7 * DAY);
    expect(await credits.grantDue(o.workspaceId)).toBe(0);
    expect(await credits.state(scope)).toMatchObject({ included: 0, total: 0 });
    expect(await credits.charge(scope, { credits: 1, refId: "after-lapse" })).toEqual({
      ok: false,
      balance: 0,
    });
    await expectReconciled(o);
  });
});

describe("review regressions", () => {
  it("refunds a charge once even when the month turned between two false-alarm marks", async () => {
    const o = await signUpWithWorkspace(ctx, "cr-refund-twice");
    const scope = scopeOf(o);
    await subscribeWorkspace(ctx, paddle, clock, o, {
      priceId: PRICES.proYear,
      plan: "pro",
      interval: "year",
      days: 365,
    });
    await credits.grantDue(o.workspaceId);
    const incidentId = newId();
    await credits.charge(scope, { credits: 5, refId: "sms-jan", incidentId });
    /* Marked a false alarm: the credits go back to the month they came from. */
    expect(await credits.refundIncident(scope, incidentId)).toBe(5);

    /* The flag is cleared, a new month is granted, and the incident is marked again. */
    clock.advance(32 * DAY);
    await credits.grantSweep();
    expect(await credits.refundIncident(scope, incidentId)).toBe(0);
    expect(await credits.state(scope)).toMatchObject({ included: 150, purchased: 0 });
    await expectReconciled(o);
  });

  it("gives the charge back as lasting credits when its month is over at the first refund", async () => {
    const o = await signUpWithWorkspace(ctx, "cr-refund-late");
    const scope = scopeOf(o);
    await subscribeWorkspace(ctx, paddle, clock, o, {
      priceId: PRICES.proYear,
      plan: "pro",
      interval: "year",
      days: 365,
    });
    await credits.grantDue(o.workspaceId);
    const incidentId = newId();
    await credits.charge(scope, { credits: 5, refId: "sms-late", incidentId });
    clock.advance(32 * DAY);
    await credits.grantSweep();
    expect(await credits.refundIncident(scope, incidentId)).toBe(5);
    expect(await credits.refundIncident(scope, incidentId)).toBe(0);
    expect(await credits.state(scope)).toMatchObject({ included: 150, purchased: 5 });
    await expectReconciled(o);
  });

  it("tops up only for the part of the month that is left after a late upgrade", async () => {
    const o = await signUpWithWorkspace(ctx, "cr-late-upgrade");
    const scope = scopeOf(o);
    await subscribeWorkspace(ctx, paddle, clock, o, {
      priceId: PRICES.starterMonth,
      plan: "starter",
    });
    expect(await credits.grantDue(o.workspaceId)).toBe(25);

    /* One day of thirty is left: Starter (25) to Business (500) adds a thirtieth of the difference. */
    clock.advance(29 * DAY);
    const upgraded = await post(o.agent, `/api/w/${o.workspaceId}/billing/plan`, {
      plan: "business",
    });
    expect(upgraded.status, upgraded.text).toBe(200);
    expect(await credits.grantDue(o.workspaceId)).toBe(16);
    expect(await credits.grantDue(o.workspaceId)).toBe(0);
    expect(await credits.state(scope)).toMatchObject({ included: 41, monthlyAllowance: 500 });
    await expectReconciled(o);
  });
});

describe("AI budget and usage metering", () => {
  it("caps an unpaid workspace at the Free allowance, even on the Pro trial", async () => {
    const o = await signUpWithWorkspace(ctx, "cr-ai-free");
    const scope = scopeOf(o);
    const start = await credits.aiBudget(scope);
    expect(start).toMatchObject({
      allowed: true,
      reason: "ok",
      funded: false,
      budgetMicros: PLANS.free.aiBudgetMicros,
      spentMicros: 0,
    });
    const usage = { provider: "anthropic" as const, kind: "explainer", units: 1_200 };
    expect(
      await credits.recordUsage(scope, { ...usage, costMicros: 60_000, ref: `g-${newId()}` }),
    ).toBe(true);
    expect((await credits.aiBudget(scope)).allowed).toBe(true);
    const ref = `g-${newId()}`;
    expect(await credits.recordUsage(scope, { ...usage, costMicros: 60_000, ref })).toBe(true);
    /* Metering the same call twice counts once. */
    expect(await credits.recordUsage(scope, { ...usage, costMicros: 60_000, ref })).toBe(false);
    expect(await credits.aiBudget(scope)).toMatchObject({
      allowed: false,
      reason: "budget_used",
      spentMicros: 120_000,
      remainingMicros: 0,
    });
  });

  it("gives a paying workspace the plan's budget for the paid month", async () => {
    const o = await signUpWithWorkspace(ctx, "cr-ai-paid");
    const scope = scopeOf(o);
    await subscribeWorkspace(ctx, paddle, clock, o, { priceId: PRICES.proMonth, plan: "pro" });
    expect(await credits.aiBudget(scope)).toMatchObject({
      allowed: true,
      funded: true,
      budgetMicros: PLANS.pro.aiBudgetMicros,
    });
    await credits.recordUsage(scope, {
      provider: "anthropic",
      kind: "digest",
      units: 90_000,
      costMicros: PLANS.pro.aiBudgetMicros,
      ref: `g-${newId()}`,
    });
    expect(await credits.aiBudget(scope)).toMatchObject({ allowed: false, reason: "budget_used" });
  });

  it("honors the kill switch and the shared cap for unpaid workspaces", async () => {
    const o = await signUpWithWorkspace(ctx, "cr-ai-cap");
    const scope = scopeOf(o);
    expect(await serviceWith({ funding: { aiEnabled: false } }).aiBudget(scope)).toMatchObject({
      allowed: false,
      reason: "disabled",
    });
    /* Other unpaid workspaces already spent more than a cap of zero allows. */
    expect(
      await serviceWith({ funding: { unfundedAiCapMicros: 0 } }).aiBudget(scope),
    ).toMatchObject({ allowed: false, reason: "platform_cap" });
    /* A paying workspace is not held back by the platform's cap. */
    const paying = await signUpWithWorkspace(ctx, "cr-ai-cap-paid");
    await subscribeWorkspace(ctx, paddle, clock, paying, {
      priceId: PRICES.starterMonth,
      plan: "starter",
    });
    expect(
      await serviceWith({ funding: { unfundedAiCapMicros: 0 } }).aiBudget(scopeOf(paying)),
    ).toMatchObject({ allowed: true, funded: true });
  });
});

describe("provider funding", () => {
  const reader = (
    provider: "twilio" | "anthropic",
    micros: number | null,
  ): ProviderBalanceReader => ({
    provider,
    balanceMicros: async () => micros,
  });

  it("adds up what customers hold and compares it with the provider balance", async () => {
    const service = serviceWith({ readers: [reader("twilio", 1_000_000_000)] });
    const before = await service.fundingStatus();
    const twilioBefore = before.find((s) => s.provider === "twilio");
    expect(twilioBefore).toMatchObject({ balanceMicros: 1_000_000_000, shortfallMicros: 0 });

    const o = await signUpWithWorkspace(ctx, "cr-fund");
    await subscribeWorkspace(ctx, paddle, clock, o, {
      priceId: PRICES.businessMonth,
      plan: "business",
    });
    await credits.grantDue(o.workspaceId);
    await credits.addPurchased(o.workspaceId, `txn_${newId()}`, 500);

    const after = await service.fundingStatus();
    const twilio = after.find((s) => s.provider === "twilio");
    const anthropic = after.find((s) => s.provider === "anthropic");
    expect((twilio?.committedMicros ?? 0) - (twilioBefore?.committedMicros ?? 0)).toBe(
      1_000 * CREDIT_PROVIDER_COST_MICROS,
    );
    expect(
      (anthropic?.committedMicros ?? 0) -
        (before.find((s) => s.provider === "anthropic")?.committedMicros ?? 0),
    ).toBe(PLANS.business.aiBudgetMicros);
    /* Anthropic reports no balance, so no shortfall can be computed. */
    expect(anthropic).toMatchObject({ balanceMicros: null, shortfallMicros: null });
    expect(anthropic?.requiredMicros).toBe(
      (anthropic?.committedMicros ?? 0) + (anthropic?.platformAllowanceMicros ?? 0),
    );

    /* Spending moves money from "committed" to "spent". */
    await credits.charge(scopeOf(o), { credits: 100, refId: "fund-1" });
    await credits.recordUsage(scopeOf(o), {
      provider: "twilio",
      kind: "sms",
      units: 100,
      costMicros: 900_000,
      ref: `sms-${newId()}`,
    });
    const spent = (await service.fundingStatus()).find((s) => s.provider === "twilio");
    expect((twilio?.committedMicros ?? 0) - (spent?.committedMicros ?? 0)).toBe(
      100 * CREDIT_PROVIDER_COST_MICROS,
    );
    expect((spent?.spentThisMonthMicros ?? 0) - (twilio?.spentThisMonthMicros ?? 0)).toBe(900_000);
  });

  it("emails the owner once a day when a balance can't cover what was paid for", async () => {
    await ctx.container.infra.redis.del("lock:funding-alert:twilio");
    const opsEmail = `ops-${newId()}@example.com`;
    const service = serviceWith({ readers: [reader("twilio", 1_000)], funding: { opsEmail } });
    const sent = async () => {
      const rows = await ctx.container.infra.db.execute<{ subject: string }>(
        sql`select payload->'data'->>'subject' as subject from outbox_events
            where type = 'email.requested' and payload->>'to' = ${opsEmail}`,
      );
      return rows.rows.map((r) => r.subject);
    };
    const statuses = await service.checkFunding();
    expect(statuses.find((s) => s.provider === "twilio")?.shortfallMicros).toBeGreaterThan(0);
    await service.checkFunding();
    const emails = await sent();
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatch(/^twilio balance is \$\d+\.\d\d short$/);
    await ctx.container.infra.redis.del("lock:funding-alert:twilio");
  });

  it("keeps working when a provider can't be reached", async () => {
    const service = serviceWith({
      readers: [
        {
          provider: "twilio",
          balanceMicros: async () => {
            throw new Error("network down");
          },
        },
      ],
    });
    const twilio = (await service.checkFunding()).find((s) => s.provider === "twilio");
    expect(twilio).toMatchObject({ balanceMicros: null, shortfallMicros: null });
  });
});
