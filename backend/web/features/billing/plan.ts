/*
 * What the plan picker offers for each plan, given the workspace's subscription. Pure, so every
 * combination is tested; the API enforces the same rules (billing.service `changePlan`).
 */
import { PLAN_KEYS, type BillingInterval, type BillingState, type CatalogPlan } from "@app/shared";

export type PlanAction =
  /* The plan and interval the subscription is on. */
  | "current"
  /* No subscription yet: open the checkout. */
  | "subscribe"
  | "upgrade"
  | "downgrade"
  /* Same plan, monthly → yearly. */
  | "switch_yearly"
  /* Free while subscribed: cancel to get there. */
  | "free"
  /* The price isn't configured on this server. */
  | "unavailable"
  /* Not active, or a cancel/pause is scheduled. */
  | "blocked_status"
  | "blocked_yearly"
  | "blocked_interval";

const rank = (key: string) => (PLAN_KEYS as readonly string[]).indexOf(key);

export function planAction(
  state: Pick<BillingState, "subscription" | "entitlements">,
  plan: Pick<CatalogPlan, "key" | "purchasable">,
  interval: BillingInterval,
): PlanAction {
  const sub = state.subscription;
  if (plan.key === "free") {
    return sub === null && state.entitlements.plan === "free" ? "current" : "free";
  }
  if (sub === null) return plan.purchasable[interval] ? "subscribe" : "unavailable";
  if (sub.plan === plan.key && sub.interval === interval) return "current";
  if (sub.status !== "active" || sub.scheduledChange !== null) return "blocked_status";
  if (sub.interval === "year" && interval === "month") return "blocked_yearly";
  if (!plan.purchasable[interval]) return "unavailable";
  if (plan.key === sub.plan) return "switch_yearly";
  if (rank(plan.key) > rank(sub.plan)) return "upgrade";
  return interval === sub.interval ? "downgrade" : "blocked_interval";
}

const usd = (fractionDigits: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
const WHOLE_USD = usd(0);
const CENTS_USD = usd(2);

/* "$9", "$7.50": display prices; Paddle shows the localized price and tax at checkout. */
export function formatUsd(amount: number): string {
  return (Number.isInteger(amount) ? WHOLE_USD : CENTS_USD).format(amount);
}

/* "3 min", "30 s". */
export function formatCheckInterval(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
}

/* Whole days until `iso`, never negative. */
export function daysUntil(iso: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - now) / 86_400_000));
}

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "long" }).format(new Date(iso));
}
