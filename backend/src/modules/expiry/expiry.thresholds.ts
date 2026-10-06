/* Which warning thresholds an expiry date has crossed (PRODUCT.md §6.1: "warn at 30/14/7/3/1 days"). */

export const SSL_DEFAULT_THRESHOLDS = [30, 14, 7, 3, 1];
export const DOMAIN_DEFAULT_THRESHOLDS = [60, 30, 14, 7, 1];
/* A certificate replaced while it still had this long to live wasn't a routine renewal. */
export const ROUTINE_RENEWAL_DAYS = 30;

const DAY_MS = 86_400_000;

/* Whole days left; negative once expired. */
export function daysUntil(expiresAt: Date, now: Date): number {
  return Math.floor((expiresAt.getTime() - now.getTime()) / DAY_MS);
}

export interface ThresholdDecision {
  days: number;
  /* Thresholds crossed now that had no notice yet. */
  newlyCrossed: number[];
  /* The most urgent new threshold: one alert, however many were crossed at once. */
  notify: number | null;
  /* True while any threshold is crossed (the warning incident should stay open). */
  warning: boolean;
}

export function crossedThresholds(
  expiresAt: Date,
  now: Date,
  thresholds: readonly number[],
  noticed: ReadonlySet<number>,
): ThresholdDecision {
  const days = daysUntil(expiresAt, now);
  const crossed = thresholds.filter((t) => days <= t);
  const newlyCrossed = crossed.filter((t) => !noticed.has(t)).sort((a, b) => b - a);
  return {
    days,
    newlyCrossed,
    notify: newlyCrossed.length > 0 ? Math.min(...newlyCrossed) : null,
    warning: crossed.length > 0,
  };
}

export function expiryPhrase(days: number): string {
  if (days < 0) return "has expired";
  if (days === 0) return "expires today";
  return `expires in ${days} day${days === 1 ? "" : "s"}`;
}
