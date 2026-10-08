/*
 * P3-T03 AC: the card-less 14-day Pro trial sends its emails on days 1, 7, 12 and 14, each once, and
 * the workspace drops to Free at the end. Time is a fake clock; the database and the composition are
 * real.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeClock } from "../../../core/clock.js";
import { createWorkspaceScope } from "../../../core/workspace-scope.js";
import {
  billingEmails,
  buildBillingApp,
  checkoutData,
  deliverAndProcess,
  eventsOf,
  fakePaddleApi,
  get,
  paddleEvent,
  PRICES,
  signUpWithWorkspace,
  subscriptionFixture,
  subscriptionPayload,
  type BillingApp,
} from "../../../__tests__/helpers/billing.js";
import { createBillingEventHandlers } from "../events/index.js";
import { dueTrialNotice } from "../trial.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

describe("dueTrialNotice", () => {
  const end = new Date("2026-10-15T00:00:00Z");
  const at = (msBeforeEnd: number) => new Date(end.getTime() - msBeforeEnd);
  const cases: Array<[string, Date, ReturnType<typeof dueTrialNotice>]> = [
    ["at the start", at(14 * DAY), { notice: "day1", send: true, skipped: [] }],
    ["an hour in", at(14 * DAY - HOUR), { notice: "day1", send: true, skipped: [] }],
    ["day 3: too late to welcome", at(11 * DAY), { notice: "day1", send: false, skipped: [] }],
    ["day 7", at(7 * DAY), { notice: "day7", send: true, skipped: ["day1"] }],
    ["day 10", at(4 * DAY), { notice: "day7", send: true, skipped: ["day1"] }],
    ["day 12", at(2 * DAY), { notice: "day12", send: true, skipped: ["day1", "day7"] }],
    ["the end", at(0), { notice: "ended", send: true, skipped: ["day1", "day7", "day12"] }],
    [
      "two days after",
      at(-2 * DAY),
      { notice: "ended", send: true, skipped: ["day1", "day7", "day12"] },
    ],
    [
      "long after",
      at(-10 * DAY),
      { notice: "ended", send: false, skipped: ["day1", "day7", "day12"] },
    ],
  ];
  it.each(cases)("%s", (_name, now, expected) => {
    expect(dueTrialNotice(now, end)).toEqual(expected);
  });

  it("has nothing to send before the trial starts", () => {
    expect(dueTrialNotice(at(15 * DAY), end)).toBeNull();
  });
});

describe("trial lifecycle", { timeout: 30_000 }, () => {
  const clock = createFakeClock(new Date());
  const paddle = fakePaddleApi(clock);
  let ctx: BillingApp;
  let owner: Awaited<ReturnType<typeof signUpWithWorkspace>>;
  let ws: string;
  const kinds = ["trial_started", "trial_midway", "trial_ending", "trial_ended"] as const;
  const sentKinds = async () => {
    const counts: Record<string, number> = {};
    for (const kind of kinds) counts[kind] = (await billingEmails(ctx, ws, kind)).length;
    return counts;
  };

  beforeAll(async () => {
    ctx = buildBillingApp(clock, paddle);
    owner = await signUpWithWorkspace(ctx, "trial");
    ws = owner.workspaceId;
  });

  afterAll(async () => {
    await ctx.container.close();
  });

  it("welcomes a new workspace once (the workspace.created handler can run twice)", async () => {
    const handle = createBillingEventHandlers({
      service: ctx.billing.service,
      trial: ctx.billing.trial,
      workspaces: ctx.workspaces.service,
    })["workspace.created"];
    if (handle === undefined) throw new Error("no workspace.created handler");
    const meta = {
      eventId: "00000000-0000-7000-8000-000000000000",
      workspaceId: ws,
      correlationId: null,
      occurredAt: new Date(),
      logger: ctx.container.infra.logger,
    };
    await handle({ workspaceId: ws }, meta);
    await handle({ workspaceId: ws }, meta);

    const emails = await billingEmails(ctx, ws, "trial_started");
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ to: owner.email, template: "billing" });
    expect((emails[0]?.data as { url: string }).url).toContain(`/w/${ws}/billing`);
    expect(await sentKinds()).toEqual({
      trial_started: 1,
      trial_midway: 0,
      trial_ending: 0,
      trial_ended: 0,
    });
  });

  it("sends the day 7 and day 12 reminders once each", async () => {
    clock.advance(6 * DAY);
    await ctx.billing.trial.sweep();
    expect((await sentKinds()).trial_midway).toBe(0);

    clock.advance(DAY + HOUR);
    await ctx.billing.trial.sweep();
    await ctx.billing.trial.sweep();
    expect(await sentKinds()).toMatchObject({ trial_midway: 1, trial_ending: 0 });

    clock.advance(5 * DAY);
    await ctx.billing.trial.sweep();
    await ctx.billing.trial.sweep();
    const ending = await billingEmails(ctx, ws, "trial_ending");
    expect(ending).toHaveLength(1);
    expect((ending[0]?.data as { daysLeft: number }).daysLeft).toBe(2);
  });

  it("drops to Free on day 14 and says so once", async () => {
    clock.advance(2 * DAY);
    const before = (await get(owner.agent, `/api/w/${ws}/entitlements`)).body;
    expect(before).toMatchObject({ plan: "free", source: "free" });
    await ctx.billing.service.runClock();
    expect(await eventsOf(ctx, ws, "billing.plan_changed")).toEqual([{ from: "pro", to: "free" }]);
    await ctx.billing.trial.sweep();
    await ctx.billing.trial.sweep();
    expect(await sentKinds()).toEqual({
      trial_started: 1,
      trial_midway: 1,
      trial_ending: 1,
      trial_ended: 1,
    });
    /* Weeks later nothing more is sent. */
    clock.advance(30 * DAY);
    await ctx.billing.trial.sweep();
    expect((await sentKinds()).trial_ended).toBe(1);
  });

  it("sends no trial reminders to a workspace that already subscribed", async () => {
    const paying = await signUpWithWorkspace(ctx, "trial-paid");
    const now = clock.now();
    const data = subscriptionFixture(
      {
        priceId: PRICES.starterMonth,
        periodStart: now,
        periodEnd: new Date(now.getTime() + 30 * DAY),
        customData: await checkoutData(paying),
      },
      now,
    );
    await deliverAndProcess(
      ctx,
      paddleEvent("subscription.created", subscriptionPayload(data), now),
    );
    /* Starter bought on day 1 keeps the trial's Pro features until the trial ends. */
    const during = (await get(paying.agent, `/api/w/${paying.workspaceId}/entitlements`)).body;
    expect(during).toMatchObject({ plan: "pro", source: "trial" });

    clock.advance(8 * DAY);
    await ctx.billing.trial.sweep();
    clock.advance(7 * DAY);
    await ctx.billing.trial.sweep();
    for (const kind of ["trial_midway", "trial_ending", "trial_ended"]) {
      expect(await billingEmails(ctx, paying.workspaceId, kind)).toHaveLength(0);
    }
    const after = (await get(paying.agent, `/api/w/${paying.workspaceId}/entitlements`)).body;
    expect(after).toMatchObject({ plan: "starter", source: "subscription" });
    await ctx.billing.service.ensureAccount(paying.workspaceId);
    expect(
      await ctx.billing.service.paidSubscription(
        createWorkspaceScope({ workspaceId: paying.workspaceId }),
      ),
    ).toBeNull();
  });
});
