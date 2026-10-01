/*
 * Billing vocabulary shared by the API and the web app (PRODUCT.md §5, §11): plan keys, what a plan
 * allows, and the shapes the billing pages read. Prices live in Paddle; limits live in the API's
 * `config/plans.ts`. Everything here is types and constants, so the web app can import it.
 */
export const PLAN_KEYS = ["free", "starter", "pro", "business"] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];
export type PaidPlanKey = Exclude<PlanKey, "free">;

export const BILLING_INTERVALS = ["month", "year"] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

/* Paddle's subscription statuses (developer.paddle.com, checked 2026-10-01). */
export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "paused",
  "canceled",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const CREDIT_PACKS = [100, 500] as const;
export type CreditPack = (typeof CREDIT_PACKS)[number];

export type Unlimited = "unlimited";

export interface PlanLimits {
  /* Monitors of every type except heartbeats. */
  monitors: number;
  heartbeats: number;
  minIntervalSeconds: number;
  regionsPerMonitor: number;
  members: number | Unlimited;
  historyDays: number;
  /* SMS, voice and WhatsApp credits included each month. */
  monthlyCredits: number;
  onCallSchedules: number | Unlimited;
  escalationPolicies: number | Unlimited;
  inboundSources: number | Unlimited;
  statusPages: number;
  statusSubscribers: number;
  aiGenerationsPerMonth: number | Unlimited;
  privateProbes: number;
  clientWorkspaces: number;
}

export const PLAN_FEATURES = [
  "smsVoice",
  "customStatusDomain",
  "privateStatusPages",
  "whiteLabel",
  "apiWrite",
  "monthlyEmailReport",
  "slaReports",
  "sso",
  "auditLog",
  "customRoles",
] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];
export type PlanFeatures = Record<PlanFeature, boolean>;

/* Why a workspace has the plan it has. `grace`: payment is overdue but features stay on for 7 days. */
export type PlanSource = "free" | "trial" | "subscription" | "grace";

export interface Entitlements {
  plan: PlanKey;
  planName: string;
  source: PlanSource;
  /* Set while the card-less Pro trial runs. */
  trialEndsAt: string | null;
  /* Set while a payment is overdue: paid features end here unless the payment goes through. */
  graceEndsAt: string | null;
  limits: PlanLimits;
  features: PlanFeatures;
}

export interface SubscriptionView {
  status: SubscriptionStatus;
  plan: PaidPlanKey;
  interval: BillingInterval;
  currentPeriodEnd: string | null;
  /* A cancellation or pause Paddle will apply at `effectiveAt`. */
  scheduledChange: { action: "cancel" | "pause" | "resume"; effectiveAt: string } | null;
  /* After a downgrade the previous plan stays until the paid period ends. */
  downgrade: { from: PlanKey; effectiveAt: string } | null;
}

export interface UsageMeter {
  used: number;
  limit: number | Unlimited;
}

export interface CatalogPlan {
  key: PlanKey;
  name: string;
  limits: PlanLimits;
  features: PlanFeatures;
  /* USD per month for display; Paddle shows the localized price and tax at checkout. */
  monthlyUsd: number;
  annualMonthlyUsd: number;
  /* False when the Paddle price for that interval is not configured on this server. */
  purchasable: Record<BillingInterval, boolean>;
}

/* Monitor counts against the plan, from the monitors API (billing can't count monitors itself). */
export interface MonitorUsage {
  monitors: UsageMeter;
  heartbeats: UsageMeter;
  /* Monitors a downgrade paused; resuming one needs room in the plan. */
  pausedByPlan: number;
}

export interface BillingState {
  entitlements: Entitlements;
  subscription: SubscriptionView | null;
  usage: { members: UsageMeter };
  catalog: {
    plans: CatalogPlan[];
    creditPacks: Array<{ credits: CreditPack; usd: number; purchasable: boolean }>;
  };
  /* What Paddle.js needs; null when Paddle is not configured on this server. */
  paddle: { environment: "sandbox" | "production"; clientToken: string } | null;
  /* The founding-customer discount (30% for life) is still available to this workspace. */
  foundingOfferAvailable: boolean;
  isFoundingCustomer: boolean;
}

/* What the page hands to Paddle.js to open the overlay checkout. */
export interface CheckoutSession {
  items: Array<{ priceId: string; quantity: number }>;
  customerEmail: string;
  /* Signed by the API; the webhook refuses custom data it did not issue. */
  customData: { workspaceId: string; userId: string; sig: string };
  discountId: string | null;
}

export const CANCEL_REASONS = [
  "too_expensive",
  "missing_feature",
  "switched_tool",
  "not_needed",
  "too_noisy",
  "other",
] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

export type CreditBucket = "included" | "purchased";

export interface CreditLedgerEntry {
  id: string;
  delta: number;
  bucket: CreditBucket;
  reason: string;
  balanceAfter: number;
  createdAt: string;
}

export interface CreditsState {
  included: number;
  purchased: number;
  total: number;
  /* The plan's monthly allowance, for the meter. */
  monthlyAllowance: number;
  lowBalance: boolean;
  recent: CreditLedgerEntry[];
}
