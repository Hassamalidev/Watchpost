/*
 * P3-T02 AC through the real composition, with Paddle's API faked and its webhook signatures real:
 * signature checks, duplicate and out-of-order events, payments arriving before subscriptions,
 * past-due grace, cancellation, plan changes, credit packs, the portal and the nightly reconcile.
 * (The sandbox run with ENV_SETUP.md's test cards needs the owner's Paddle keys; see PRODUCT.md §22.)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { createFakeClock } from "../../../core/clock.js";
import { ProviderError } from "../../../core/errors.js";
import { createWorkspaceScope } from "../../../core/workspace-scope.js";
import { emailFromOutbox } from "../../../__tests__/helpers/container-app.js";
import {
  billingEmails,
  buildBillingApp,
  checkoutData,
  deliver,
  deliverAndProcess,
  eventsOf,
  fakePaddleApi,
  get,
  paddleEvent,
  post,
  PRICES,
  signPaddle,
  signUpWithWorkspace,
  subscriptionFixture,
  subscriptionPayload,
  transactionPayload,
  type BillingApp,
} from "../../../__tests__/helpers/billing.js";
import { billingEvents } from "../schema/billing.js";

const DAY = 86_400_000;
const clock = createFakeClock(new Date());
const paddle = fakePaddleApi(clock);
let ctx: BillingApp;

type Owner = Awaited<ReturnType<typeof signUpWithWorkspace>>;

const state = async (o: Owner) => (await get(o.agent, `/api/w/${o.workspaceId}/billing`)).body;
const later = (ms: number) => new Date(clock.now().getTime() + ms);

/* Subscribes a workspace the way a checkout does: subscription webhook, then the payment. */
async function subscribe(o: Owner, priceId: string = PRICES.starterMonth, paid = true) {
  const now = clock.now();
  const data = subscriptionFixture(
    {
      priceId,
      periodStart: now,
      periodEnd: later(30 * DAY),
      customData: await checkoutData(o),
      customerId: `ctm_${o.workspaceId.slice(0, 8)}`,
    },
    now,
  );
  paddle.put(data);
  expect(
    await deliverAndProcess(
      ctx,
      paddleEvent("subscription.created", subscriptionPayload(data), now),
    ),
  ).toBe("applied");
  if (paid) {
    await deliverAndProcess(
      ctx,
      paddleEvent(
        "transaction.completed",
        transactionPayload({
          subscriptionId: data.id,
          items: data.items,
          period: { startsAt: now, endsAt: later(30 * DAY) },
        }),
        now,
      ),
    );
  }
  return data;
}

beforeAll(async () => {
  ctx = buildBillingApp(clock, paddle);
  /* The local test database outlives a run: start from no founders and no half-processed events. */
  const db = ctx.container.infra.db;
  await db.execute(sql`update billing_accounts set founding_number = null`);
  await db.execute(
    sql`update billing_events set processed_at = now(), outcome = 'ignored' where processed_at is null`,
  );
});

afterAll(async () => {
  await ctx.container.close();
});

describe("webhook endpoint", () => {
  it("refuses unsigned, wrongly signed and replayed requests before storing anything", async () => {
    const event = paddleEvent("subscription.created", {}, clock.now());
    const body = JSON.stringify(event);
    const send = (signature?: string) => {
      const req = request(ctx.app)
        .post("/api/webhooks/paddle")
        .set("content-type", "application/json");
      if (signature !== undefined) req.set("paddle-signature", signature);
      return req.send(body);
    };
    expect((await send()).status).toBe(401);
    expect((await send("nonsense")).status).toBe(401);
    expect((await send(signPaddle(body, "another-secret-0123456789"))).status).toBe(401);
    expect((await send(signPaddle(body, undefined, Date.now() - 60_000))).status).toBe(401);
    /* A signature for a different body doesn't cover this one. */
    expect((await send(signPaddle(`${body} `))).status).toBe(401);
    const stored = await ctx.container.infra.db
      .select()
      .from(billingEvents)
      .where(eq(billingEvents.eventId, event.event_id));
    expect(stored).toHaveLength(0);
  });

  it("rejects a signed body that isn't a Paddle event", async () => {
    expect((await deliver(ctx, { hello: "world" })).status).toBe(400);
  });

  it("stores an event once and processes it once", async () => {
    const o = await signUpWithWorkspace(ctx, "pdl-dup");
    const now = clock.now();
    const data = subscriptionFixture(
      {
        priceId: PRICES.proMonth,
        periodStart: now,
        periodEnd: later(30 * DAY),
        customData: await checkoutData(o, "pro"),
      },
      now,
    );
    const event = paddleEvent("subscription.created", subscriptionPayload(data), now);
    expect((await deliver(ctx, event)).body).toEqual({ outcome: "accepted" });
    expect((await deliver(ctx, event)).body).toEqual({ outcome: "duplicate" });
    expect(await ctx.billing.sync.process(event.event_id)).toBe("applied");
    expect(await ctx.billing.sync.process(event.event_id)).toBe("applied");
    expect(await ctx.billing.sync.process("evt_never_delivered")).toBe("missing");

    const body = await state(o);
    expect(body.subscription).toMatchObject({ status: "active", plan: "pro", interval: "month" });
    expect(body.entitlements).toMatchObject({ plan: "pro", source: "subscription" });
    /* One welcome email per contact, even though the event ran twice. */
    expect(await billingEmails(ctx, o.workspaceId, "subscription_started")).toHaveLength(1);
  });

  it("re-queues stored events whose job was lost", async () => {
    const event = paddleEvent("customer.updated", { id: "ctm_1" }, clock.now());
    await deliver(ctx, event);
    expect(await ctx.billing.sync.recover()).toBe(0);
    clock.advance(2 * 60_000);
    expect(await ctx.billing.sync.recover()).toBeGreaterThanOrEqual(1);
    expect(await ctx.billing.sync.process(event.event_id)).toBe("ignored");
  });
});

describe("linking a subscription to a workspace", () => {
  it("refuses custom data our checkout didn't sign", async () => {
    const victim = await signUpWithWorkspace(ctx, "pdl-victim");
    const now = clock.now();
    const forged = subscriptionFixture(
      {
        priceId: PRICES.businessMonth,
        periodStart: now,
        periodEnd: later(30 * DAY),
        customData: { workspaceId: victim.workspaceId, userId: "someone", sig: "forged" },
      },
      now,
    );
    expect(
      await deliverAndProcess(
        ctx,
        paddleEvent("subscription.created", subscriptionPayload(forged), now),
      ),
    ).toBe("unlinked");
    const unsigned = subscriptionFixture(
      { priceId: PRICES.businessMonth, periodStart: now, periodEnd: later(30 * DAY) },
      now,
    );
    expect(
      await deliverAndProcess(
        ctx,
        paddleEvent("subscription.created", subscriptionPayload(unsigned), now),
      ),
    ).toBe("unlinked");
    expect((await state(victim)).subscription).toBeNull();
  });

  it("keeps the first subscription when a second one arrives for the same workspace", async () => {
    const o = await signUpWithWorkspace(ctx, "pdl-second");
    const first = await subscribe(o, PRICES.proMonth);
    const now = clock.now();
    const second = subscriptionFixture(
      {
        priceId: PRICES.starterMonth,
        periodStart: now,
        periodEnd: later(30 * DAY),
        customData: { ...first.customData },
      },
      now,
    );
    expect(
      await deliverAndProcess(
        ctx,
        paddleEvent("subscription.created", subscriptionPayload(second), now),
      ),
    ).toBe("conflict");
    expect((await state(o)).subscription).toMatchObject({ plan: "pro" });
  });

  it("flags a subscription whose prices this server doesn't know", async () => {
    const o = await signUpWithWorkspace(ctx, "pdl-unknown");
    const now = clock.now();
    const data = subscriptionFixture(
      {
        priceId: "pri_somethingelse",
        periodStart: now,
        periodEnd: later(30 * DAY),
        customData: await checkoutData(o),
      },
      now,
    );
    expect(
      await deliverAndProcess(
        ctx,
        paddleEvent("subscription.created", subscriptionPayload(data), now),
      ),
    ).toBe("unknown_plan");
  });
});

describe("event order and paid periods", () => {
  it("ignores an event older than the newest one applied", async () => {
    const o = await signUpWithWorkspace(ctx, "pdl-order");
    const data = await subscribe(o, PRICES.proMonth);
    const newer = { ...data, status: "active" as const, updatedAt: later(10_000) };
    const older = { ...data, status: "past_due" as const, updatedAt: later(5_000) };
    expect(
      await deliverAndProcess(
        ctx,
        paddleEvent("subscription.updated", subscriptionPayload(newer), later(10_000)),
      ),
    ).toBe("applied");
    expect(
      await deliverAndProcess(
        ctx,
        paddleEvent("subscription.past_due", subscriptionPayload(older), later(5_000)),
      ),
    ).toBe("stale");
    expect((await state(o)).subscription.status).toBe("active");
  });

  it("announces a paid period once, whichever of payment and subscription arrives first", async () => {
    const o = await signUpWithWorkspace(ctx, "pdl-paid");
    const now = clock.now();
    const data = subscriptionFixture(
      {
        priceId: PRICES.starterMonth,
        periodStart: now,
        periodEnd: later(30 * DAY),
        customData: await checkoutData(o),
      },
      now,
    );
    /* The payment first: Paddle doesn't promise an order. Its period is filled in later. */
    const payment = paddleEvent(
      "transaction.completed",
      transactionPayload({ subscriptionId: data.id, items: data.items, period: null }),
      now,
    );
    expect(await deliverAndProcess(ctx, payment)).toBe("applied");
    expect(await eventsOf(ctx, o.workspaceId, "billing.period_renewed")).toHaveLength(0);

    await deliverAndProcess(
      ctx,
      paddleEvent("subscription.created", subscriptionPayload(data), now),
    );
    await deliverAndProcess(
      ctx,
      paddleEvent("subscription.activated", subscriptionPayload(data), later(1_000)),
    );
    const renewed = await eventsOf(ctx, o.workspaceId, "billing.period_renewed");
    expect(renewed).toHaveLength(1);
    expect(renewed[0]?.periodEnd).toBe(later(30 * DAY).toISOString());
    const paid = await ctx.billing.service.paidSubscription(
      createWorkspaceScope({ workspaceId: o.workspaceId }),
    );
    expect(paid).toMatchObject({ plan: "starter" });
    expect(paid?.paidPeriodEnd.toISOString()).toBe(later(30 * DAY).toISOString());
  });

  it("does not treat an unpaid renewal as paid, and announces it when the money arrives", async () => {
    const o = await signUpWithWorkspace(ctx, "pdl-renew");
    const data = await subscribe(o, PRICES.proMonth);
    expect(await eventsOf(ctx, o.workspaceId, "billing.period_renewed")).toHaveLength(1);

    /* Paddle moves the period forward before the card is charged. */
    const nextStart = later(30 * DAY);
    const nextEnd = later(60 * DAY);
    const rolled = {
      ...data,
      periodStart: nextStart,
      periodEnd: nextEnd,
      updatedAt: later(20_000),
    };
    await deliverAndProcess(
      ctx,
      paddleEvent("subscription.updated", subscriptionPayload(rolled), later(20_000)),
    );
    expect(await eventsOf(ctx, o.workspaceId, "billing.period_renewed")).toHaveLength(1);

    /*
     * None of these pays for the new period: a proration inside the period already paid for, an
     * update charge that names no period, and a one-time charge.
     */
    const notPeriodPayments = [
      {
        origin: "subscription_update",
        items: data.items,
        period: { startsAt: later(10 * DAY), endsAt: later(30 * DAY) },
      },
      { origin: "subscription_update", items: data.items, period: null },
      {
        origin: "subscription_charge",
        items: [{ priceId: PRICES.credits100, quantity: 1 }],
        period: null,
      },
    ];
    for (const [index, payment] of notPeriodPayments.entries()) {
      await deliverAndProcess(
        ctx,
        paddleEvent(
          "transaction.completed",
          transactionPayload({ subscriptionId: data.id, ...payment }),
          later(21_000 + index),
        ),
      );
    }
    expect(await eventsOf(ctx, o.workspaceId, "billing.period_renewed")).toHaveLength(1);

    const renewal = paddleEvent(
      "transaction.completed",
      transactionPayload({
        subscriptionId: data.id,
        origin: "subscription_recurring",
        items: data.items,
        period: { startsAt: nextStart, endsAt: nextEnd },
      }),
      later(22_000),
    );
    await deliverAndProcess(ctx, renewal);
    await ctx.billing.sync.process(renewal.event_id);
    const renewed = await eventsOf(ctx, o.workspaceId, "billing.period_renewed");
    expect(renewed).toHaveLength(2);
    expect(renewed[0]?.periodEnd).toBe(nextEnd.toISOString());
  });

  it("counts a switch to yearly billing as a paid year", async () => {
    const o = await signUpWithWorkspace(ctx, "pdl-yearly");
    const data = await subscribe(o, PRICES.proMonth);
    /* Paddle starts a new yearly period now and charges it as a subscription update. */
    const yearEnd = later(365 * DAY);
    const yearly = {
      ...data,
      items: [{ priceId: PRICES.proYear, quantity: 1 }],
      periodStart: clock.now(),
      periodEnd: yearEnd,
      updatedAt: later(5_000),
    };
    await deliverAndProcess(
      ctx,
      paddleEvent("subscription.updated", subscriptionPayload(yearly), later(5_000)),
    );
    await deliverAndProcess(
      ctx,
      paddleEvent(
        "transaction.completed",
        transactionPayload({
          subscriptionId: data.id,
          origin: "subscription_update",
          items: yearly.items,
          period: { startsAt: clock.now(), endsAt: yearEnd },
        }),
        later(6_000),
      ),
    );
    const renewed = await eventsOf(ctx, o.workspaceId, "billing.period_renewed");
    expect(renewed).toHaveLength(2);
    expect(renewed[0]?.periodEnd).toBe(yearEnd.toISOString());
    const paid = await ctx.billing.service.paidSubscription(
      createWorkspaceScope({ workspaceId: o.workspaceId }),
    );
    expect(paid?.paidPeriodEnd.toISOString()).toBe(yearEnd.toISOString());
    expect((await state(o)).subscription).toMatchObject({ plan: "pro", interval: "year" });
  });

  it("turns a paid credit pack into a credits_purchased event", async () => {
    const o = await signUpWithWorkspace(ctx, "pdl-pack");
    const data = await subscribe(o);
    const event = paddleEvent(
      "transaction.completed",
      transactionPayload({
        id: "txn_pack_0001",
        subscriptionId: data.id,
        origin: "subscription_charge",
        items: [{ priceId: PRICES.credits500, quantity: 2 }],
      }),
      later(1_000),
    );
    expect(await deliverAndProcess(ctx, event)).toBe("applied");
    expect(await eventsOf(ctx, o.workspaceId, "billing.credits_purchased")).toEqual([
      { transactionId: "txn_pack_0001", credits: 1_000 },
    ]);
    /* A pack nobody can be credited for is flagged, not dropped silently. */
    const orphan = paddleEvent(
      "transaction.completed",
      transactionPayload({ items: [{ priceId: PRICES.credits100, quantity: 1 }] }),
      later(2_000),
    );
    expect(await deliverAndProcess(ctx, orphan)).toBe("unlinked");
  });
});

describe("overdue payments and cancellation", () => {
  it("keeps paid features for 7 days after a failed renewal, then drops to Free", async () => {
    const o = await signUpWithWorkspace(ctx, "pdl-due");
    const data = await subscribe(o, PRICES.proMonth);
    clock.advance(15 * DAY);
    const failedAt = clock.now();
    await deliverAndProcess(
      ctx,
      paddleEvent(
        "transaction.payment_failed",
        transactionPayload({
          subscriptionId: data.id,
          origin: "subscription_recurring",
          items: data.items,
          status: "past_due",
        }),
        failedAt,
      ),
    );
    const overdue = { ...data, status: "past_due" as const, updatedAt: failedAt };
    await deliverAndProcess(
      ctx,
      paddleEvent("subscription.past_due", subscriptionPayload(overdue), failedAt),
    );

    const body = await state(o);
    expect(body.subscription.status).toBe("past_due");
    expect(body.entitlements).toMatchObject({ plan: "pro", source: "grace" });
    expect(Date.parse(body.entitlements.graceEndsAt)).toBe(failedAt.getTime() + 7 * DAY);
    const emails = await billingEmails(ctx, o.workspaceId, "payment_failed");
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ to: o.email });
    /* Changing plans waits for the payment. */
    expect(
      (await post(o.agent, `/api/w/${o.workspaceId}/billing/plan`, { plan: "business" })).status,
    ).toBe(409);

    clock.advance(7 * DAY + 60_000);
    expect((await state(o)).entitlements).toMatchObject({ plan: "free", source: "free" });
    await ctx.billing.service.runClock();
    expect((await eventsOf(ctx, o.workspaceId, "billing.plan_changed"))[0]).toEqual({
      from: "pro",
      to: "free",
    });

    /* The card works again: paid features return. */
    const recovered = { ...data, status: "active" as const, updatedAt: clock.now() };
    await deliverAndProcess(
      ctx,
      paddleEvent("subscription.updated", subscriptionPayload(recovered), clock.now()),
    );
    expect((await state(o)).entitlements).toMatchObject({ plan: "pro", source: "subscription" });
    expect(await billingEmails(ctx, o.workspaceId, "subscription_started")).toHaveLength(1);
  });

  it("moves to Free when Paddle cancels, keeps the history and allows a new checkout", async () => {
    const o = await signUpWithWorkspace(ctx, "pdl-cancel");
    clock.advance(15 * DAY);
    const data = await subscribe(o, PRICES.starterMonth);
    expect(
      (await post(o.agent, `/api/w/${o.workspaceId}/billing/checkout`, { plan: "pro" })).status,
    ).toBe(409);

    const at = later(1_000);
    const canceled = { ...data, status: "canceled" as const, canceledAt: at, updatedAt: at };
    expect(
      await deliverAndProcess(
        ctx,
        paddleEvent("subscription.canceled", subscriptionPayload(canceled), at),
      ),
    ).toBe("applied");
    const body = await state(o);
    expect(body.subscription).toBeNull();
    expect(body.entitlements.plan).toBe("free");
    expect(await billingEmails(ctx, o.workspaceId, "subscription_canceled")).toHaveLength(1);
    expect(
      (await post(o.agent, `/api/w/${o.workspaceId}/billing/checkout`, { plan: "pro" })).status,
    ).toBe(200);
    /* Invoices stay reachable after the subscription ended. */
    const portal = await post(o.agent, `/api/w/${o.workspaceId}/billing/portal`);
    expect(portal.status, portal.text).toBe(200);
    expect(portal.body.url).toContain("customer-portal.paddle.com");
  });
});

describe("billing actions", () => {
  let o: Owner;
  let sub: Awaited<ReturnType<typeof subscribe>>;
  const path = (suffix: string) => `/api/w/${o.workspaceId}/billing${suffix}`;

  beforeAll(async () => {
    o = await signUpWithWorkspace(ctx, "pdl-act");
    clock.advance(15 * DAY);
  });

  it("issues signed checkout data to billing managers only", async () => {
    const res = await post(o.agent, path("/checkout"), { plan: "starter", interval: "year" });
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({
      items: [{ priceId: PRICES.starterYear, quantity: 1 }],
      customerEmail: o.email,
      customData: { workspaceId: o.workspaceId, userId: o.userId },
      discountId: "dsc_founding30",
    });
    expect(res.body.customData.sig).toBe(ctx.billing.sync.signCheckout(o.workspaceId, o.userId));
    /* Business annual has no price on this server. */
    const unsold = await post(o.agent, path("/checkout"), { plan: "business", interval: "year" });
    expect(unsold.status).toBe(503);
    expect((await post(o.agent, path("/checkout"), { plan: "free" })).status).toBe(400);
    expect((await request(ctx.app).post(path("/checkout")).send({ plan: "pro" })).status).toBe(401);
    expect((await post(o.agent, path("/portal"))).status).toBe(404);
    expect((await post(o.agent, path("/credits"), { credits: 100 })).status).toBe(409);
    expect((await post(o.agent, path("/cancel"), { reason: "other" })).status).toBe(404);
  });

  it("shows the catalog and what can be bought", async () => {
    const body = await state(o);
    expect(body.paddle).toEqual({
      environment: "sandbox",
      clientToken: "test_client_token_0123456789",
    });
    const plans = Object.fromEntries(
      (body.catalog.plans as Array<{ key: string; purchasable: object }>).map((p) => [
        p.key,
        p.purchasable,
      ]),
    );
    expect(plans).toEqual({
      free: { month: false, year: false },
      starter: { month: true, year: true },
      pro: { month: true, year: true },
      business: { month: true, year: false },
    });
    expect(body.catalog.creditPacks).toEqual([
      { credits: 100, usd: 6, purchasable: true },
      { credits: 500, usd: 25, purchasable: true },
    ]);
    expect(body.foundingOfferAvailable).toBe(true);
  });

  it("upgrades at once with prorated billing", async () => {
    sub = await subscribe(o, PRICES.starterMonth);
    const res = await post(o.agent, path("/plan"), { plan: "pro", interval: "month" });
    expect(res.status, res.text).toBe(200);
    expect(paddle.calls.at(-1)).toEqual({
      method: "updateItems",
      id: sub.id,
      items: [{ priceId: PRICES.proMonth, quantity: 1 }],
      mode: "prorated_immediately",
    });
    expect(res.body.subscription).toMatchObject({ plan: "pro", downgrade: null });
    expect(res.body.entitlements.plan).toBe("pro");
    expect((await post(o.agent, path("/plan"), { plan: "pro" })).status).toBe(409);
  });

  it("downgrades without billing and holds the old plan until the paid period ends", async () => {
    const res = await post(o.agent, path("/plan"), { plan: "starter", interval: "month" });
    expect(res.status, res.text).toBe(200);
    expect(paddle.calls.at(-1)).toMatchObject({ method: "updateItems", mode: "do_not_bill" });
    expect(res.body.subscription).toMatchObject({
      plan: "starter",
      downgrade: { from: "pro", effectiveAt: sub.periodEnd?.toISOString() },
    });
    expect(res.body.entitlements).toMatchObject({ plan: "pro", source: "subscription" });
    /* Paddle's own webhook for the same change doesn't end the hold. */
    const echoed = paddle.subscriptions.get(sub.id);
    if (echoed === undefined) throw new Error("fake subscription missing");
    await deliverAndProcess(
      ctx,
      paddleEvent("subscription.updated", subscriptionPayload(echoed), later(1_000)),
    );
    expect((await state(o)).entitlements.plan).toBe("pro");
    /* Later (a webhook is never from the future), the customer switches to annual billing. */
    clock.advance(60_000);
    const annual = await post(o.agent, path("/plan"), { plan: "starter", interval: "year" });
    expect(annual.status, annual.text).toBe(200);
    expect(annual.body.subscription).toMatchObject({ plan: "starter", interval: "year" });
  });

  it("refuses annual to monthly and mixed downgrades with a clear message", async () => {
    const toMonthly = await post(o.agent, path("/plan"), { plan: "starter", interval: "month" });
    expect(toMonthly.status).toBe(409);
    expect(toMonthly.body.detail).toContain("renewal");
  });

  it("buys a credit pack with the saved payment method, one purchase at a time", async () => {
    const before = paddle.calls.length;
    const res = await post(o.agent, path("/credits"), { credits: 100 });
    expect(res.status, res.text).toBe(202);
    expect(paddle.calls.at(-1)).toEqual({
      method: "chargeNow",
      id: sub.id,
      items: [{ priceId: PRICES.credits100, quantity: 1 }],
    });
    expect(paddle.calls.length).toBe(before + 1);
    expect((await post(o.agent, path("/credits"), { credits: 250 })).status).toBe(400);
  });

  it("reports Paddle's refusal instead of pretending the change happened", async () => {
    paddle.failNextCall(new ProviderError("paddle", "Paddle could not change the plan."));
    const res = await post(o.agent, path("/plan"), { plan: "pro", interval: "year" });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("provider_error");
    expect((await state(o)).subscription.plan).toBe("starter");
  });

  it("cancels at the period end with a reason, and can be kept", async () => {
    const res = await post(o.agent, path("/cancel"), {
      reason: "too_expensive",
      comment: "Budget cut",
    });
    expect(res.status, res.text).toBe(200);
    expect(res.body.subscription.scheduledChange).toMatchObject({ action: "cancel" });
    expect(res.body.subscription.status).toBe("active");
    expect((await post(o.agent, path("/cancel"), { reason: "other" })).status).toBe(409);
    expect((await post(o.agent, path("/cancel"), { reason: "because" })).status).toBe(400);
    /* A scheduled cancel blocks plan changes until it is undone. */
    expect((await post(o.agent, path("/plan"), { plan: "pro", interval: "year" })).status).toBe(
      409,
    );

    const kept = await post(o.agent, path("/resume"));
    expect(kept.status, kept.text).toBe(200);
    expect(kept.body.subscription.scheduledChange).toBeNull();
    expect((await post(o.agent, path("/resume"))).status).toBe(409);
  });

  it("pauses at the period end and resumes", async () => {
    const paused = await post(o.agent, path("/pause"));
    expect(paused.status, paused.text).toBe(200);
    expect(paused.body.subscription.scheduledChange).toMatchObject({ action: "pause" });
    expect((await post(o.agent, path("/pause"))).status).toBe(409);
    expect((await post(o.agent, path("/resume"))).body.subscription.scheduledChange).toBeNull();

    /* Paddle applies a pause: features stop, the subscription stays, and it can be resumed. */
    const current = paddle.subscriptions.get(sub.id);
    if (current === undefined) throw new Error("fake subscription missing");
    const at = later(5_000);
    current.status = "paused";
    current.updatedAt = at;
    await deliverAndProcess(
      ctx,
      paddleEvent("subscription.paused", subscriptionPayload(current), at),
    );
    expect((await state(o)).entitlements.plan).toBe("free");
    clock.advance(60_000);
    const resumed = await post(o.agent, path("/resume"));
    expect(resumed.status, resumed.text).toBe(200);
    expect(resumed.body.subscription.status).toBe("active");
  });

  it("lets members read billing but not change it", async () => {
    const member = await signUpWithWorkspace(ctx, "pdl-member");
    const invite = await post(o.agent, "/api/auth/organization/invite-member", {
      email: member.email,
      role: "member",
      organizationId: o.workspaceId,
    });
    expect(invite.status, invite.text).toBe(200);
    const { url } = await emailFromOutbox(ctx.container, member.email, "invite");
    const accepted = await post(member.agent, "/api/auth/organization/accept-invitation", {
      invitationId: String(url).split("/").at(-1),
    });
    expect(accepted.status, accepted.text).toBe(200);
    expect((await get(member.agent, path(""))).status).toBe(200);
    for (const action of ["/checkout", "/plan"]) {
      expect((await post(member.agent, path(action), { plan: "pro" })).status).toBe(403);
    }
    for (const action of ["/pause", "/resume", "/portal"]) {
      expect((await post(member.agent, path(action))).status).toBe(403);
    }
    expect((await post(member.agent, path("/cancel"), { reason: "other" })).status).toBe(403);
    expect((await post(member.agent, path("/credits"), { credits: 100 })).status).toBe(403);
  });

  it("follows Paddle when the nightly reconcile finds a difference", async () => {
    const current = paddle.subscriptions.get(sub.id);
    if (current === undefined) throw new Error("fake subscription missing");
    current.status = "canceled";
    current.canceledAt = later(10_000);
    current.updatedAt = later(10_000);
    const result = await ctx.billing.sync.reconcile();
    expect(result.checked).toBeGreaterThanOrEqual(1);
    expect((await state(o)).subscription).toBeNull();
    expect((await state(o)).entitlements.plan).toBe("free");
  });
});

describe("founding customers", () => {
  it("numbers workspaces that subscribed with the founding discount", async () => {
    const o = await signUpWithWorkspace(ctx, "pdl-founder");
    const now = clock.now();
    const data = subscriptionFixture(
      {
        priceId: PRICES.proMonth,
        periodStart: now,
        periodEnd: later(30 * DAY),
        customData: await checkoutData(o, "pro"),
        discountId: "dsc_founding30",
      },
      now,
    );
    await deliverAndProcess(
      ctx,
      paddleEvent("subscription.created", subscriptionPayload(data), now),
    );
    await deliverAndProcess(
      ctx,
      paddleEvent("subscription.activated", subscriptionPayload(data), later(1_000)),
    );
    const body = await state(o);
    expect(body.isFoundingCustomer).toBe(true);
    expect(body.foundingOfferAvailable).toBe(false);
  });
});
