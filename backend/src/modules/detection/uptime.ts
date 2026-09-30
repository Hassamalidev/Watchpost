/*
 * Uptime math (PRODUCT.md §9.9), as pure functions over `downtimes`:
 *   uptime % = 1 − (downtime seconds in range, plus maintenance unless excluded) ÷ range seconds.
 * Only outages (and maintenance, when counted) are downtime; degraded time is reported but is not
 * downtime. Time before the monitor existed is outside the range. Never from sampled checks.
 */
import type { DowntimeKind } from "./schema/detection.js";

export interface DowntimeSpan {
  kind: DowntimeKind;
  startedAt: Date;
  /* Null while still open. */
  endedAt: Date | null;
}

export interface UptimeSummary {
  from: string;
  to: string;
  rangeSeconds: number;
  downtimeSeconds: number;
  degradedSeconds: number;
  maintenanceSeconds: number;
  /* Null when the range is empty (the monitor didn't exist yet). */
  uptimePercent: number | null;
}

/* Seconds of `span` inside [from, to), with open spans running until `now`. */
function overlapSeconds(span: DowntimeSpan, from: Date, to: Date, now: Date): number {
  const start = Math.max(span.startedAt.getTime(), from.getTime());
  const end = Math.min((span.endedAt ?? now).getTime(), to.getTime());
  return Math.max(0, (end - start) / 1_000);
}

export function computeUptime(input: {
  spans: readonly DowntimeSpan[];
  from: Date;
  to: Date;
  now: Date;
  /* When the monitor was created; earlier time doesn't count. */
  since: Date;
  excludeMaintenance: boolean;
}): UptimeSummary {
  const from = new Date(Math.max(input.from.getTime(), input.since.getTime()));
  const to = new Date(Math.min(input.to.getTime(), input.now.getTime()));
  const rangeSeconds = Math.max(0, (to.getTime() - from.getTime()) / 1_000);
  const sum = (kind: DowntimeKind) =>
    input.spans
      .filter((s) => s.kind === kind)
      .reduce((total, s) => total + overlapSeconds(s, from, to, input.now), 0);
  const outage = sum("outage");
  const maintenance = sum("maintenance");
  const degraded = sum("degraded");
  const downtime = outage + (input.excludeMaintenance ? 0 : maintenance);
  const denominator = rangeSeconds - (input.excludeMaintenance ? maintenance : 0);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    rangeSeconds: Math.round(rangeSeconds),
    downtimeSeconds: Math.round(downtime),
    degradedSeconds: Math.round(degraded),
    maintenanceSeconds: Math.round(maintenance),
    uptimePercent:
      denominator <= 0
        ? null
        : Math.round(Math.max(0, 1 - downtime / denominator) * 1_000_000) / 10_000,
  };
}

export type DayStatus = "up" | "minor" | "major" | "none";

export interface UptimeDay {
  date: string;
  uptimePercent: number | null;
  downtimeSeconds: number;
  status: DayStatus;
}

/* Status-page day bars (§9.9): ≥ 99.9 % green, ≥ 99 % amber, otherwise red; "none" before creation. */
export function uptimeDays(input: {
  spans: readonly DowntimeSpan[];
  days: number;
  now: Date;
  since: Date;
  excludeMaintenance: boolean;
  thresholds?: { up: number; minor: number };
}): UptimeDay[] {
  const { up, minor } = input.thresholds ?? { up: 99.9, minor: 99 };
  const today = Date.UTC(
    input.now.getUTCFullYear(),
    input.now.getUTCMonth(),
    input.now.getUTCDate(),
  );
  const result: UptimeDay[] = [];
  for (let i = input.days - 1; i >= 0; i -= 1) {
    const start = new Date(today - i * 86_400_000);
    const end = new Date(start.getTime() + 86_400_000);
    const summary = computeUptime({
      spans: input.spans,
      from: start,
      to: end,
      now: input.now,
      since: input.since,
      excludeMaintenance: input.excludeMaintenance,
    });
    const pct = summary.uptimePercent;
    result.push({
      date: start.toISOString().slice(0, 10),
      uptimePercent: pct,
      downtimeSeconds: summary.downtimeSeconds,
      status: pct === null ? "none" : pct >= up ? "up" : pct >= minor ? "minor" : "major",
    });
  }
  return result;
}
