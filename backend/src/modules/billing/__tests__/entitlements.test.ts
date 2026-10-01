/* P3-T01: the plan resolver as a table of cases with fixed clocks (trial, grace, downgrade hold). */
import { describe, expect, it } from "vitest";
import { NO_ADDONS, PLANS, limitsFor } from "../../../config/plans.js";
import { resolvePlan, toEntitlements, type SubscriptionSnapshot } from "../entitlements.js";

const at = (iso: string) => new Date(iso);
const NOW = at("2026-10-10T00:00:00Z");

const sub = (patch: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot => ({
  status: "active",
  planKey: "starter",
  heldPlanKey: null,
  heldUntil: null,
  pastDueSince: null,
  addons: NO_ADDONS,
  ...patch,
});

describe("resolvePlan", () => {
  const cases: Array<{
    name: string;
    trialEndsAt: string | null;
    subscription: SubscriptionSnapshot | null;
    plan: string;
    source: string;
    next: string | null;
  }> = [
    {
      name: "no trial, no subscription: Free forever",
      trialEndsAt: null,
      subscription: null,
      plan: "free",
      source: "free",
      next: null,
    },
    {
      name: "running trial: Pro until it ends",
      trialEndsAt: "2026-10-14T00:00:00Z",
      subscription: null,
      plan: "pro",
      source: "trial",
      next: "2026-10-14T00:00:00.000Z",
    },
    {
      name: "trial ended exactly now: Free",
      trialEndsAt: "2026-10-10T00:00:00Z",
      subscription: null,
      plan: "free",
      source: "free",
      next: null,
    },
    {
      name: "active subscription after the trial",
      trialEndsAt: "2026-10-01T00:00:00Z",
      subscription: sub({ planKey: "business" }),
      plan: "business",
      source: "subscription",
      next: null,
    },
    {
      name: "Starter bought during the trial keeps Pro until the trial ends",
      trialEndsAt: "2026-10-14T00:00:00Z",
      subscription: sub({ planKey: "starter" }),
      plan: "pro",
      source: "trial",
      next: "2026-10-14T00:00:00.000Z",
    },
    {
      name: "Business bought during the trial applies at once",
      trialEndsAt: "2026-10-14T00:00:00Z",
      subscription: sub({ planKey: "business" }),
      plan: "business",
      source: "subscription",
      next: null,
    },
    {
      name: "Paddle trialing status counts as live",
      trialEndsAt: null,
      subscription: sub({ status: "trialing", planKey: "pro" }),
      plan: "pro",
      source: "subscription",
      next: null,
    },
    {
      name: "overdue payment: full features during the 7-day grace",
      trialEndsAt: null,
      subscription: sub({
        status: "past_due",
        planKey: "pro",
        pastDueSince: at("2026-10-05T00:00:00Z"),
      }),
      plan: "pro",
      source: "grace",
      next: "2026-10-12T00:00:00.000Z",
    },
    {
      name: "overdue for more than 7 days: Free",
      trialEndsAt: null,
      subscription: sub({
        status: "past_due",
        planKey: "pro",
        pastDueSince: at("2026-10-03T00:00:00Z"),
      }),
      plan: "free",
      source: "free",
      next: null,
    },
    {
      name: "overdue without a recorded start: treated as lapsed",
      trialEndsAt: null,
      subscription: sub({ status: "past_due", planKey: "pro" }),
      plan: "free",
      source: "free",
      next: null,
    },
    {
      name: "paused subscription: Free",
      trialEndsAt: null,
      subscription: sub({ status: "paused", planKey: "pro" }),
      plan: "free",
      source: "free",
      next: null,
    },
    {
      name: "canceled subscription: Free",
      trialEndsAt: null,
      subscription: sub({ status: "canceled", planKey: "business" }),
      plan: "free",
      source: "free",
      next: null,
    },
    {
      name: "downgrade: the old plan is held until the paid period ends",
      trialEndsAt: null,
      subscription: sub({
        planKey: "starter",
        heldPlanKey: "business",
        heldUntil: at("2026-10-20T00:00:00Z"),
      }),
      plan: "business",
      source: "subscription",
      next: "2026-10-20T00:00:00.000Z",
    },
    {
      name: "downgrade hold over: the new plan applies",
      trialEndsAt: null,
      subscription: sub({
        planKey: "starter",
        heldPlanKey: "business",
        heldUntil: at("2026-10-09T00:00:00Z"),
      }),
      plan: "starter",
      source: "subscription",
      next: null,
    },
    {
      name: "a held plan lower than the current one is ignored",
      trialEndsAt: null,
      subscription: sub({
        planKey: "pro",
        heldPlanKey: "starter",
        heldUntil: at("2026-10-20T00:00:00Z"),
      }),
      plan: "pro",
      source: "subscription",
      next: null,
    },
    {
      name: "canceled subscription with a running trial falls back to the trial",
      trialEndsAt: "2026-10-14T00:00:00Z",
      subscription: sub({ status: "canceled" }),
      plan: "pro",
      source: "trial",
      next: "2026-10-14T00:00:00.000Z",
    },
  ];

  it.each(cases)("$name", ({ trialEndsAt, subscription, plan, source, next }) => {
    const result = resolvePlan({
      now: NOW,
      trialEndsAt: trialEndsAt === null ? null : at(trialEndsAt),
      subscription,
    });
    expect(result.plan).toBe(plan);
    expect(result.source).toBe(source);
    expect(result.nextChangeAt?.toISOString() ?? null).toBe(next);
  });

  it("reports the earliest boundary when a trial and a grace period overlap", () => {
    const result = resolvePlan({
      now: NOW,
      trialEndsAt: at("2026-10-14T00:00:00Z"),
      subscription: sub({ status: "past_due", pastDueSince: at("2026-10-04T00:00:00Z") }),
    });
    expect(result.plan).toBe("pro");
    expect(result.nextChangeAt?.toISOString()).toBe("2026-10-11T00:00:00.000Z");
  });
});

describe("limits and add-ons", () => {
  it("adds 100 monitors per pack on Pro and Business only", () => {
    const addons = { extraMonitors100: 2, extraProbe: 1, extraClientWorkspace: 3 };
    expect(limitsFor("pro", addons).monitors).toBe(350);
    expect(limitsFor("pro", addons).privateProbes).toBe(2);
    expect(limitsFor("pro", addons).clientWorkspaces).toBe(0);
    expect(limitsFor("business", addons).clientWorkspaces).toBe(13);
    expect(limitsFor("starter", addons)).toEqual(PLANS.starter.limits);
  });

  it("applies add-ons only when the subscription is what grants the plan", () => {
    const addons = { extraMonitors100: 1, extraProbe: 0, extraClientWorkspace: 0 };
    const paid = toEntitlements(
      resolvePlan({ now: NOW, trialEndsAt: null, subscription: sub({ planKey: "pro", addons }) }),
    );
    expect(paid.limits.monitors).toBe(250);
    const trial = toEntitlements(
      resolvePlan({
        now: NOW,
        trialEndsAt: at("2026-10-14T00:00:00Z"),
        subscription: sub({ planKey: "starter", addons }),
      }),
    );
    expect(trial).toMatchObject({ plan: "pro", source: "trial", planName: "Pro" });
    expect(trial.limits.monitors).toBe(150);
  });

  it("matches the pricing table (§5)", () => {
    expect(PLANS.free.limits).toMatchObject({ monitors: 20, heartbeats: 5, members: 3 });
    expect(PLANS.starter.limits).toMatchObject({ monitors: 50, monthlyCredits: 25, members: 5 });
    expect(PLANS.pro.limits).toMatchObject({ monitors: 150, monthlyCredits: 150 });
    expect(PLANS.business.limits).toMatchObject({ monitors: 500, monthlyCredits: 500 });
    expect(PLANS.free.features.smsVoice).toBe(false);
    expect(PLANS.business.features.sso).toBe(true);
    expect(PLANS.pro.features.sso).toBe(false);
  });
});
