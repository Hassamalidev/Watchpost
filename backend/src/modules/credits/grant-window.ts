/*
 * Which month of a paid period we are in. Credits are monthly (PRODUCT.md §5) but an annual plan is
 * paid once a year, so a paid period is cut into month-long windows; each window gets one grant.
 * Pure, so month ends, leap years and Paddle's slightly uneven periods are tested without a database.
 */
const DAY_MS = 86_400_000;
const AVERAGE_MONTH_DAYS = 30.44;

/* The same day of the month `months` later, clamped to the month's last day (31 Jan → 28 Feb). */
export function addMonthsUtc(date: Date, months: number): Date {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

export interface GrantWindow {
  start: Date;
  end: Date;
}

/*
 * The window containing `now`, or null outside the paid period. The number of windows comes from the
 * period's length (a month is one window, a year is twelve), so a period that ends a little after a
 * calendar month boundary never creates a short extra window with a second grant.
 */
export function grantWindow(periodStart: Date, periodEnd: Date, now: Date): GrantWindow | null {
  const t = now.getTime();
  if (t < periodStart.getTime() || t >= periodEnd.getTime()) return null;
  const days = (periodEnd.getTime() - periodStart.getTime()) / DAY_MS;
  const windows = Math.max(1, Math.round(days / AVERAGE_MONTH_DAYS));
  let index = 0;
  while (index < windows - 1 && addMonthsUtc(periodStart, index + 1).getTime() <= t) index += 1;
  const start = addMonthsUtc(periodStart, index);
  const end = index === windows - 1 ? periodEnd : addMonthsUtc(periodStart, index + 1);
  return { start, end: end.getTime() < periodEnd.getTime() ? end : periodEnd };
}
