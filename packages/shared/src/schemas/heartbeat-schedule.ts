/*
 * Heartbeat schedules (PRODUCT.md §6.7, §9.7): when the next ping is due — `period` after the last
 * one, or the next cron time in the schedule's time zone — and full validation of cron schedules.
 */
import { CronExpressionParser } from "cron-parser";

export type HeartbeatSchedule =
  | { kind: "period"; periodSeconds: number }
  | { kind: "cron"; expression: string; timezone: string };

export function nextExpectedAt(schedule: HeartbeatSchedule, after: Date): Date {
  if (schedule.kind === "period") return new Date(after.getTime() + schedule.periodSeconds * 1_000);
  return CronExpressionParser.parse(schedule.expression, {
    currentDate: after,
    tz: schedule.timezone,
  })
    .next()
    .toDate();
}

/* Null when valid, otherwise why not. */
export function cronProblem(expression: string, timezone: string): string | null {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    return `"${timezone}" is not a known time zone`;
  }
  try {
    CronExpressionParser.parse(expression, { tz: timezone }).next();
    return null;
  } catch (err) {
    return `"${expression}" is not a valid cron expression: ${err instanceof Error ? err.message : String(err)}`;
  }
}
