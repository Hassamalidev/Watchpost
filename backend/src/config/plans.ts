/*
 * Plans and limits (PRODUCT.md §5), the single source for entitlements. Prices live in Paddle;
 * this file only knows what each plan allows. Draft until Open decision #3.
 */
import { REGIONS } from "@app/shared";

export const PLAN_KEYS = ["free", "starter", "pro", "business"] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

export interface PlanLimits {
  /* Monitors of every type except heartbeats. */
  monitors: number;
  heartbeats: number;
  minIntervalSeconds: number;
  regionsPerMonitor: number;
  members: number | "unlimited";
  historyDays: number;
}

export const PLANS: Record<PlanKey, { name: string; limits: PlanLimits }> = {
  free: {
    name: "Free",
    limits: {
      monitors: 20,
      heartbeats: 5,
      minIntervalSeconds: 180,
      regionsPerMonitor: 2,
      members: 3,
      historyDays: 30,
    },
  },
  starter: {
    name: "Starter",
    limits: {
      monitors: 50,
      heartbeats: 20,
      minIntervalSeconds: 60,
      regionsPerMonitor: 3,
      members: 5,
      historyDays: 183,
    },
  },
  pro: {
    name: "Pro",
    limits: {
      monitors: 150,
      heartbeats: 75,
      minIntervalSeconds: 30,
      regionsPerMonitor: 5,
      members: "unlimited",
      historyDays: 396,
    },
  },
  business: {
    name: "Business",
    limits: {
      monitors: 500,
      heartbeats: 250,
      /* 15 s requires a verified domain (§5, §12); enforced with domain verification in P3. */
      minIntervalSeconds: 15,
      regionsPerMonitor: REGIONS.length,
      members: "unlimited",
      historyDays: 761,
    },
  },
};

/* Until entitlements land (P3-T01), every workspace gets Free limits. */
export function freeLimits(): PlanLimits {
  return PLANS.free.limits;
}
