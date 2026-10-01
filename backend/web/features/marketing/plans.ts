/*
 * Plans shown on the landing page (PRODUCT.md §5, draft until Open decision #3). Keys match the
 * billing catalog's PLAN_KEYS on phase/3-monetization; prices are whole USD per month.
 */
export const MARKETING_PLAN_KEYS = ["free", "starter", "pro", "business"] as const;
export type MarketingPlanKey = (typeof MARKETING_PLAN_KEYS)[number];

export interface MarketingPlan {
  key: MarketingPlanKey;
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

export const isMarketingPlanKey = (value: string | null | undefined): value is MarketingPlanKey =>
  MARKETING_PLAN_KEYS.includes(value as MarketingPlanKey);

/* The plan picked on the landing page, kept for the billing page after sign-up. */
export const SELECTED_PLAN_STORAGE_KEY = "watchpost.selectedPlan";

export const formatPlanPrice = (amount: number) =>
  Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
