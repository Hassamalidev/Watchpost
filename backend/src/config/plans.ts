/*
 * Plans and limits (PRODUCT.md §5), the single source for entitlements. Prices live in Paddle; this
 * file knows what each plan allows, what the add-ons add and which upstream budgets a paid month
 * funds (PRODUCT.md §11 "Upstream funding"). Draft until Open decision #3.
 */
import {
  BILLING_INTERVALS,
  CREDIT_PACKS,
  PLAN_KEYS,
  REGIONS,
  type BillingInterval,
  type CreditPack,
  type PaidPlanKey,
  type PlanFeatures,
  type PlanKey,
  type PlanLimits,
} from "@app/shared";

export { PLAN_KEYS };
export const PAID_PLAN_KEYS = ["starter", "pro", "business"] as const satisfies PaidPlanKey[];
export type { PaidPlanKey, PlanFeatures, PlanKey, PlanLimits };

export interface PlanDefinition {
  name: string;
  /* Display prices in USD (§5); Paddle is the source of what is actually charged. */
  monthlyUsd: number;
  annualMonthlyUsd: number;
  limits: PlanLimits;
  features: PlanFeatures;
  /*
   * What we may spend on Claude for one workspace in one month, in micro-USD. On paid plans the
   * month's subscription payment funds it; on Free it is the platform's own allowance.
   */
  aiBudgetMicros: number;
}

const NO_FEATURES: PlanFeatures = {
  smsVoice: false,
  customStatusDomain: false,
  privateStatusPages: false,
  whiteLabel: false,
  apiWrite: false,
  monthlyEmailReport: false,
  slaReports: false,
  sso: false,
  auditLog: false,
  customRoles: false,
};

export const PLANS: Record<PlanKey, PlanDefinition> = {
  free: {
    name: "Free",
    monthlyUsd: 0,
    annualMonthlyUsd: 0,
    limits: {
      monitors: 20,
      heartbeats: 5,
      minIntervalSeconds: 180,
      regionsPerMonitor: 2,
      members: 3,
      historyDays: 30,
      monthlyCredits: 0,
      onCallSchedules: 0,
      escalationPolicies: 0,
      inboundSources: 1,
      statusPages: 1,
      statusSubscribers: 0,
      aiGenerationsPerMonth: 20,
      privateProbes: 0,
      clientWorkspaces: 0,
    },
    features: NO_FEATURES,
    aiBudgetMicros: 100_000,
  },
  starter: {
    name: "Starter",
    monthlyUsd: 9,
    annualMonthlyUsd: 7.5,
    limits: {
      monitors: 50,
      heartbeats: 20,
      minIntervalSeconds: 60,
      regionsPerMonitor: 3,
      members: 5,
      historyDays: 183,
      monthlyCredits: 25,
      onCallSchedules: 1,
      escalationPolicies: 1,
      inboundSources: 3,
      statusPages: 3,
      statusSubscribers: 0,
      aiGenerationsPerMonth: 100,
      privateProbes: 0,
      clientWorkspaces: 0,
    },
    features: {
      ...NO_FEATURES,
      smsVoice: true,
      customStatusDomain: true,
      apiWrite: true,
      monthlyEmailReport: true,
    },
    aiBudgetMicros: 500_000,
  },
  pro: {
    name: "Pro",
    monthlyUsd: 29,
    annualMonthlyUsd: 24,
    limits: {
      monitors: 150,
      heartbeats: 75,
      minIntervalSeconds: 30,
      regionsPerMonitor: 5,
      members: "unlimited",
      historyDays: 396,
      monthlyCredits: 150,
      onCallSchedules: "unlimited",
      escalationPolicies: "unlimited",
      inboundSources: "unlimited",
      statusPages: 10,
      statusSubscribers: 2_000,
      aiGenerationsPerMonth: "unlimited",
      privateProbes: 1,
      clientWorkspaces: 0,
    },
    features: {
      ...NO_FEATURES,
      smsVoice: true,
      customStatusDomain: true,
      apiWrite: true,
      monthlyEmailReport: true,
      slaReports: true,
    },
    aiBudgetMicros: 5_000_000,
  },
  business: {
    name: "Business",
    monthlyUsd: 79,
    annualMonthlyUsd: 66,
    limits: {
      monitors: 500,
      heartbeats: 250,
      /* 15 s requires a verified domain (§5, §12); enforced with domain verification in P3. */
      minIntervalSeconds: 15,
      regionsPerMonitor: REGIONS.length,
      members: "unlimited",
      historyDays: 761,
      monthlyCredits: 500,
      onCallSchedules: "unlimited",
      escalationPolicies: "unlimited",
      inboundSources: "unlimited",
      statusPages: 50,
      statusSubscribers: 20_000,
      aiGenerationsPerMonth: "unlimited",
      privateProbes: 5,
      clientWorkspaces: 10,
    },
    features: {
      smsVoice: true,
      customStatusDomain: true,
      privateStatusPages: true,
      whiteLabel: true,
      apiWrite: true,
      monthlyEmailReport: true,
      slaReports: true,
      sso: true,
      auditLog: true,
      customRoles: true,
    },
    aiBudgetMicros: 5_000_000,
  },
};

/* Every new workspace starts on this plan for TRIAL_DAYS without a card (§5, D-006). */
export const TRIAL_PLAN: PlanKey = "pro";
/* A failed renewal keeps paid features for this long while Paddle retries the card (§11). */
export const PAST_DUE_GRACE_DAYS = 7;
/* The first paying workspaces keep 30% off for life (§5). */
export const FOUNDING_CUSTOMER_SLOTS = 100;

const RANK: Record<PlanKey, number> = { free: 0, starter: 1, pro: 2, business: 3 };

export function planRank(plan: PlanKey): number {
  return RANK[plan];
}

export function isPlanKey(value: unknown): value is PlanKey {
  return typeof value === "string" && (PLAN_KEYS as readonly string[]).includes(value);
}

/* Recurring add-ons a subscription can carry next to its plan (§5). */
export const ADDON_KEYS = ["extraMonitors100", "extraProbe", "extraClientWorkspace"] as const;
export type AddonKey = (typeof ADDON_KEYS)[number];
export type AddonQuantities = Record<AddonKey, number>;

export const NO_ADDONS: AddonQuantities = {
  extraMonitors100: 0,
  extraProbe: 0,
  extraClientWorkspace: 0,
};

/* Monthly prices of the add-ons (§5). */
export const ADDON_MONTHLY_USD: Record<AddonKey, number> = {
  extraMonitors100: 15,
  extraProbe: 10,
  extraClientWorkspace: 5,
};

/*
 * What one credit may cost us at the provider, in micro-USD. The cheapest credit sells for $0.05 (the
 * 500 pack) and §5 asks for at least a 3× margin, so the per-country multipliers (P3-T05) must keep
 * the real cost of a credit at or under this. Funding sets this much aside for every credit a
 * customer holds.
 */
export const CREDIT_PROVIDER_COST_MICROS = 16_000;

/* Display prices of the one-time credit packs (§5). */
export const CREDIT_PACK_USD: Record<CreditPack, number> = { 100: 6, 500: 25 };

/*
 * A plan's limits with the subscription's add-ons applied. "+100 monitors" is sold on Pro and
 * Business only; on other plans a stray quantity adds nothing.
 */
export function limitsFor(plan: PlanKey, addons: AddonQuantities = NO_ADDONS): PlanLimits {
  const base = PLANS[plan].limits;
  const paidTier = plan === "pro" || plan === "business";
  return {
    ...base,
    monitors: base.monitors + (paidTier ? addons.extraMonitors100 * 100 : 0),
    privateProbes: base.privateProbes + (paidTier ? addons.extraProbe : 0),
    clientWorkspaces:
      base.clientWorkspaces + (plan === "business" ? addons.extraClientWorkspace : 0),
  };
}

export function freeLimits(): PlanLimits {
  return PLANS.free.limits;
}

/* Paddle price IDs from the environment (PADDLE_PRICE_*); undefined means "not sold on this server". */
export interface PriceIds {
  plans: Record<PaidPlanKey, Record<BillingInterval, string | undefined>>;
  credits: Record<CreditPack, string | undefined>;
  addons: Record<AddonKey, string | undefined>;
}

export type PriceRef =
  | { kind: "plan"; plan: PaidPlanKey; interval: BillingInterval }
  | { kind: "credits"; credits: CreditPack }
  | { kind: "addon"; addon: AddonKey };

export interface PriceCatalog {
  /* What a Paddle price ID sells, or undefined for a price we don't know. */
  lookup(priceId: string): PriceRef | undefined;
  planPrice(plan: PaidPlanKey, interval: BillingInterval): string | undefined;
  creditPrice(credits: CreditPack): string | undefined;
  addonPrice(addon: AddonKey): string | undefined;
}

export function createPriceCatalog(ids: PriceIds): PriceCatalog {
  const byId = new Map<string, PriceRef>();
  for (const plan of PAID_PLAN_KEYS) {
    for (const interval of BILLING_INTERVALS) {
      const id = ids.plans[plan][interval];
      if (id !== undefined) byId.set(id, { kind: "plan", plan, interval });
    }
  }
  for (const credits of CREDIT_PACKS) {
    const id = ids.credits[credits];
    if (id !== undefined) byId.set(id, { kind: "credits", credits });
  }
  for (const addon of ADDON_KEYS) {
    const id = ids.addons[addon];
    if (id !== undefined) byId.set(id, { kind: "addon", addon });
  }
  return {
    lookup: (priceId) => byId.get(priceId),
    planPrice: (plan, interval) => ids.plans[plan][interval],
    creditPrice: (credits) => ids.credits[credits],
    addonPrice: (addon) => ids.addons[addon],
  };
}

export const NO_PRICES: PriceIds = {
  plans: {
    starter: { month: undefined, year: undefined },
    pro: { month: undefined, year: undefined },
    business: { month: undefined, year: undefined },
  },
  credits: { 100: undefined, 500: undefined },
  addons: { extraMonitors100: undefined, extraProbe: undefined, extraClientWorkspace: undefined },
};
