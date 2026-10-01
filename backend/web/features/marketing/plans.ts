/*
 * Plans shown on the public site (PRODUCT.md §5, draft until Open decision #3). Public pages are
 * static, so display prices are repeated here; the API's `config/plans.ts` is the source of truth, and
 * a price change has to be made in both (backlog, §21.2).
 */
import { PLAN_KEYS, type BillingInterval, type PlanKey } from "@app/shared";

export type MarketingPlanKey = PlanKey;

export interface MarketingPlan {
  key: PlanKey;
  monthly: number;
  /* Per month when billed annually (two months free). */
  annual: number;
  highlighted?: boolean;
}

export const MARKETING_PLANS: readonly MarketingPlan[] = [
  { key: "free", monthly: 0, annual: 0 },
  { key: "starter", monthly: 9, annual: 7.5 },
  { key: "pro", monthly: 29, annual: 24, highlighted: true },
  { key: "business", monthly: 79, annual: 66 },
];

/* Lines per plan card; the text lives in messages under marketing.plans.<key>.<line>. */
export const PLAN_FEATURE_KEYS = ["f1", "f2", "f3", "f4", "f5", "f6"] as const;

/*
 * Rows of the pricing table; labels and values live in messages under marketing.table.<row>.
 * `soon` marks what the plans promise but the product does not ship yet, so the page says so.
 */
export const PLAN_TABLE_ROWS: ReadonlyArray<{
  key:
    | "monitors"
    | "heartbeats"
    | "interval"
    | "regions"
    | "members"
    | "channels"
    | "history"
    | "credits"
    | "statusPages"
    | "onCall"
    | "ai"
    | "privateProbes"
    | "api"
    | "sso"
    | "support";
  soon?: boolean;
}> = [
  { key: "monitors" },
  { key: "heartbeats" },
  { key: "interval" },
  { key: "regions" },
  { key: "members" },
  { key: "channels" },
  { key: "history" },
  { key: "credits", soon: true },
  { key: "statusPages", soon: true },
  { key: "onCall", soon: true },
  { key: "ai", soon: true },
  { key: "privateProbes", soon: true },
  { key: "api", soon: true },
  { key: "sso", soon: true },
  { key: "support" },
];

export const FAQ_KEYS = ["1", "2", "3", "4", "5", "6", "7"] as const;

export const isMarketingPlanKey = (value: string | null | undefined): value is PlanKey =>
  PLAN_KEYS.includes(value as PlanKey);

/* The plan picked on the public site, kept for the billing page after sign-up. */
export const SELECTED_PLAN_STORAGE_KEY = "watchpost.selectedPlan";

export interface SelectedPlan {
  plan: Exclude<PlanKey, "free">;
  interval: BillingInterval;
}

/* Reads the stored choice; anything unexpected counts as no choice. */
export function parseSelectedPlan(raw: string | null): SelectedPlan | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { plan?: string; billing?: string };
    if (!isMarketingPlanKey(value.plan) || value.plan === "free") return null;
    return { plan: value.plan, interval: value.billing === "annual" ? "year" : "month" };
  } catch {
    return null;
  }
}

export const formatPlanPrice = (amount: number) =>
  Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
