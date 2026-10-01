/*
 * Which plan a workspace is on right now (PRODUCT.md §5, §11). Pure: time comes in as `now`, so trial
 * ends, payment grace and downgrade dates are tested with fixed clocks.
 *
 * Rules, in order:
 * 1. A live subscription (active or trialing) gives its plan. After a downgrade the previous plan is
 *    held until the period the customer already paid for ends.
 * 2. An overdue subscription keeps its plan for PAST_DUE_GRACE_DAYS, then counts as lapsed.
 * 3. Paused, canceled or lapsed subscriptions give nothing.
 * 4. While the card-less trial runs the workspace has at least the trial plan, so paying for Starter
 *    on day 2 never takes Pro features away early.
 * 5. Otherwise Free.
 */
import type {
  Entitlements,
  PaidPlanKey,
  PlanKey,
  PlanSource,
  SubscriptionStatus,
} from "@app/shared";
import {
  NO_ADDONS,
  PAST_DUE_GRACE_DAYS,
  PLANS,
  TRIAL_PLAN,
  limitsFor,
  planRank,
  type AddonQuantities,
} from "../../config/plans.js";

const DAY_MS = 86_400_000;

export interface SubscriptionSnapshot {
  status: SubscriptionStatus;
  planKey: PaidPlanKey;
  heldPlanKey: PlanKey | null;
  heldUntil: Date | null;
  pastDueSince: Date | null;
  addons: AddonQuantities;
}

export interface PlanResolution {
  plan: PlanKey;
  source: PlanSource;
  /* Set only while the trial is what gives the workspace its plan. */
  trialEndsAt: Date | null;
  graceEndsAt: Date | null;
  addons: AddonQuantities;
  /* The next moment the answer changes without any new input; null if it never does. */
  nextChangeAt: Date | null;
}

function subscriptionPlan(
  now: Date,
  sub: SubscriptionSnapshot | null,
): { plan: PlanKey; grace: Date | null; boundaries: Date[] } | null {
  if (sub === null) return null;
  const boundaries: Date[] = [];
  let grace: Date | null = null;
  if (sub.status === "past_due") {
    /* Without a recorded start the grace period can't be measured, so it is treated as over. */
    if (sub.pastDueSince === null) return null;
    grace = new Date(sub.pastDueSince.getTime() + PAST_DUE_GRACE_DAYS * DAY_MS);
    if (now.getTime() >= grace.getTime()) return null;
    boundaries.push(grace);
  } else if (sub.status !== "active" && sub.status !== "trialing") {
    return null;
  }
  let plan: PlanKey = sub.planKey;
  if (
    sub.heldPlanKey !== null &&
    sub.heldUntil !== null &&
    now.getTime() < sub.heldUntil.getTime() &&
    planRank(sub.heldPlanKey) > planRank(plan)
  ) {
    plan = sub.heldPlanKey;
    boundaries.push(sub.heldUntil);
  }
  return { plan, grace, boundaries };
}

export function resolvePlan(input: {
  now: Date;
  trialEndsAt: Date | null;
  subscription: SubscriptionSnapshot | null;
}): PlanResolution {
  const { now, trialEndsAt } = input;
  const trialActive = trialEndsAt !== null && now.getTime() < trialEndsAt.getTime();
  const fromSub = subscriptionPlan(now, input.subscription);
  const earliest = (dates: Date[]): Date | null =>
    dates.length === 0 ? null : new Date(Math.min(...dates.map((d) => d.getTime())));

  if (fromSub !== null) {
    const addons = input.subscription?.addons ?? NO_ADDONS;
    if (trialActive && planRank(fromSub.plan) < planRank(TRIAL_PLAN)) {
      return {
        plan: TRIAL_PLAN,
        source: "trial",
        trialEndsAt,
        graceEndsAt: fromSub.grace,
        addons: NO_ADDONS,
        nextChangeAt: earliest([trialEndsAt, ...fromSub.boundaries]),
      };
    }
    return {
      plan: fromSub.plan,
      source: fromSub.grace === null ? "subscription" : "grace",
      trialEndsAt: null,
      graceEndsAt: fromSub.grace,
      addons,
      nextChangeAt: earliest(fromSub.boundaries),
    };
  }
  if (trialActive) {
    return {
      plan: TRIAL_PLAN,
      source: "trial",
      trialEndsAt,
      graceEndsAt: null,
      addons: NO_ADDONS,
      nextChangeAt: trialEndsAt,
    };
  }
  return {
    plan: "free",
    source: "free",
    trialEndsAt: null,
    graceEndsAt: null,
    addons: NO_ADDONS,
    nextChangeAt: null,
  };
}

export function toEntitlements(resolution: PlanResolution): Entitlements {
  const definition = PLANS[resolution.plan];
  return {
    plan: resolution.plan,
    planName: definition.name,
    source: resolution.source,
    trialEndsAt: resolution.trialEndsAt?.toISOString() ?? null,
    graceEndsAt: resolution.graceEndsAt?.toISOString() ?? null,
    limits: limitsFor(resolution.plan, resolution.addons),
    features: definition.features,
  };
}
