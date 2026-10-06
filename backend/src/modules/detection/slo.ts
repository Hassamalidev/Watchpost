/*
 * Monthly error budgets (SLOs): a monitor's availability target (99.9 % by default) allows a fixed
 * amount of downtime per calendar month (UTC). The budget view shows how much is used and whether the
 * current pace would use it all before the month ends — so teams see trouble coming, not just
 * outages that already happened. Pure: the service supplies the downtime.
 */

export type BudgetStatus = "healthy" | "at_risk" | "exhausted";

export interface ErrorBudget {
  target: number;
  periodStart: string;
  periodEnd: string;
  /* Downtime the target allows over the whole month. */
  budgetSeconds: number;
  usedSeconds: number;
  remainingSeconds: number;
  /* Used share of the budget relative to the elapsed share of the month (1 = exactly on pace). */
  burnRate: number;
  status: BudgetStatus;
}

export function monthOf(at: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { start, end };
}

export function errorBudget(input: {
  target: number;
  usedSeconds: number;
  now: Date;
}): ErrorBudget {
  const { start, end } = monthOf(input.now);
  const monthSeconds = (end.getTime() - start.getTime()) / 1_000;
  const budgetSeconds = Math.round(((100 - input.target) / 100) * monthSeconds);
  const elapsed = Math.max(1, (input.now.getTime() - start.getTime()) / 1_000) / monthSeconds;
  const usedSeconds = Math.round(input.usedSeconds);
  const remainingSeconds = budgetSeconds - usedSeconds;
  const burnRate = budgetSeconds === 0 ? 0 : usedSeconds / budgetSeconds / elapsed;
  const status: BudgetStatus =
    remainingSeconds <= 0 ? "exhausted" : burnRate > 1 ? "at_risk" : "healthy";
  return {
    target: input.target,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    budgetSeconds,
    usedSeconds,
    remainingSeconds,
    burnRate: Math.round(burnRate * 100) / 100,
    status,
  };
}
