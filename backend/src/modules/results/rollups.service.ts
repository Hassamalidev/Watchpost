/*
 * Rollups and charts (PRODUCT.md §7.7, §9.9). Each rollup job recomputes the recent complete buckets
 * of its size with an idempotent upsert, so re-runs and late results (probes buffer while offline)
 * converge: 5-minute buckets from raw results over the last hour, hourly from 5-minute over the last
 * 3 hours, daily (UTC) from hourly over the last 2 days, which also applies retention. Charts read
 * the coarsest rollup that fits the range and merge regions by summing histograms.
 */
import type { Clock } from "../../core/clock.js";
import { QuotaExceededError } from "../../core/errors.js";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import type { MonitorsService } from "../monitors/index.js";
import { mergeHistograms, percentile } from "./histogram.js";
import type { ResultsRepository, RollupSize } from "./results.repository.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const CHART_RANGES = {
  "1h": { ms: HOUR, size: "5m" },
  "24h": { ms: DAY, size: "5m" },
  "7d": { ms: 7 * DAY, size: "1h" },
  "30d": { ms: 30 * DAY, size: "1h" },
  "90d": { ms: 90 * DAY, size: "1d" },
} as const satisfies Record<string, { ms: number; size: RollupSize }>;
export type ChartRange = keyof typeof CHART_RANGES;

/* Retention (§7.7): 5-minute rows 90 days, hourly 25 months, daily forever. */
export const RETENTION_MS = { "5m": 90 * DAY, "1h": 760 * DAY } as const;

export interface LatencyPoint {
  bucket: string;
  count: number;
  failCount: number;
  avgMs: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

/* Successful checks' latency over a period; nulls when there were none. */
export interface LatencyTotals {
  checks: number;
  avgMs: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface LatencySeries {
  range: ChartRange;
  resolution: RollupSize;
  region: string | null;
  points: LatencyPoint[];
  summary: Omit<LatencyPoint, "bucket">;
}

export interface CheckView {
  id: string;
  checkedAt: string;
  region: string;
  ok: boolean;
  errorCode: string | null;
  httpStatus: number | null;
  latencyMs: number;
  message: string | null;
  timings: unknown;
}

export interface RollupsService {
  /* Recomputes the recent complete buckets of one size. Returns rows written. */
  rollup(size: RollupSize): Promise<{ written: number; deleted: number }>;
  latency(
    scope: WorkspaceScope,
    monitorId: string,
    options: { range: ChartRange; region?: string | undefined },
  ): Promise<LatencySeries>;
  /*
   * Latency of many monitors of the workspace over [from, to), per monitor and for all of them
   * together (SLA reports). Read from hourly rollups, or daily ones once the hourly are gone, so a
   * period's hours that haven't been rolled up yet aren't in it. The caller checked the monitors.
   */
  latencyBetween(
    scope: WorkspaceScope,
    monitorIds: string[],
    from: Date,
    to: Date,
  ): Promise<{ byMonitor: Map<string, LatencyTotals>; all: LatencyTotals }>;
  /* Raw checks from the last 48 hours, newest first (per-check charts and waterfalls). */
  checks(
    scope: WorkspaceScope,
    monitorId: string,
    options: { limit: number; region?: string | undefined },
  ): Promise<CheckView[]>;
}

const floorTo = (ms: number, step: number) => Math.floor(ms / step) * step;

function point(
  rows: Array<{
    count: number;
    failCount: number;
    okCount: number;
    latencySum: number;
    histogram: number[];
  }>,
): Omit<LatencyPoint, "bucket"> {
  const histogram = mergeHistograms(rows.map((r) => r.histogram));
  const ok = rows.reduce((a, r) => a + r.okCount, 0);
  const sum = rows.reduce((a, r) => a + r.latencySum, 0);
  return {
    count: rows.reduce((a, r) => a + r.count, 0),
    failCount: rows.reduce((a, r) => a + r.failCount, 0),
    avgMs: ok === 0 ? null : Math.round((sum / ok) * 10) / 10,
    p50: percentile(histogram, 0.5),
    p95: percentile(histogram, 0.95),
    p99: percentile(histogram, 0.99),
  };
}

export function createRollupsService(deps: {
  repository: ResultsRepository;
  monitors: Pick<MonitorsService, "get" | "planLimits">;
  clock: Clock;
}): RollupsService {
  const { repository: repo, clock } = deps;

  return {
    async rollup(size) {
      const now = clock.now().getTime();
      if (size === "5m") {
        const end = floorTo(now, 5 * MINUTE);
        return { written: await repo.rollupRaw(new Date(end - HOUR), new Date(end)), deleted: 0 };
      }
      if (size === "1h") {
        const end = floorTo(now, HOUR);
        return {
          written: await repo.rollupFrom("1h", new Date(end - 3 * HOUR), new Date(end)),
          deleted: 0,
        };
      }
      const end = floorTo(now, DAY);
      const written = await repo.rollupFrom("1d", new Date(end - 2 * DAY), new Date(end));
      const deleted =
        (await repo.deleteRollupsBefore("5m", new Date(now - RETENTION_MS["5m"]))) +
        (await repo.deleteRollupsBefore("1h", new Date(now - RETENTION_MS["1h"])));
      return { written, deleted };
    },

    async latency(scope, monitorId, { range, region }) {
      await deps.monitors.get(scope, monitorId);
      /* History beyond the plan's window is an upgrade moment (§5), not an empty chart. */
      const { historyDays } = await deps.monitors.planLimits(scope);
      if (CHART_RANGES[range].ms > historyDays * DAY) {
        throw new QuotaExceededError(
          `Your plan keeps ${historyDays} days of history. Upgrade to see the last ${range}.`,
        );
      }
      const { ms, size } = CHART_RANGES[range];
      const now = clock.now();
      const rows = await repo.rollups(size, monitorId, new Date(now.getTime() - ms), now, region);
      const byBucket = new Map<number, typeof rows>();
      for (const row of rows) {
        const key = row.bucket.getTime();
        byBucket.set(key, [...(byBucket.get(key) ?? []), row]);
      }
      return {
        range,
        resolution: size,
        region: region ?? null,
        points: [...byBucket.entries()]
          .sort(([a], [b]) => a - b)
          .map(([bucket, bucketRows]) => ({
            bucket: new Date(bucket).toISOString(),
            ...point(bucketRows),
          })),
        summary: point(rows),
      };
    },

    async latencyBetween(scope, monitorIds, from, to) {
      const size: RollupSize =
        from.getTime() < clock.now().getTime() - RETENTION_MS["1h"] ? "1d" : "1h";
      const rows = await repo.rollupTotals(size, scope.workspaceId, monitorIds, from, to);
      const totals = (list: typeof rows): LatencyTotals => {
        const histogram = mergeHistograms(list.map((r) => r.histogram));
        const ok = list.reduce((a, r) => a + r.okCount, 0);
        const sum = list.reduce((a, r) => a + r.latencySum, 0);
        return {
          checks: list.reduce((a, r) => a + r.count, 0),
          avgMs: ok === 0 ? null : Math.round((sum / ok) * 10) / 10,
          p50: percentile(histogram, 0.5),
          p95: percentile(histogram, 0.95),
          p99: percentile(histogram, 0.99),
        };
      };
      return {
        byMonitor: new Map(rows.map((row) => [row.monitorId, totals([row])])),
        all: totals(rows),
      };
    },

    async checks(scope, monitorId, { limit, region }) {
      await deps.monitors.get(scope, monitorId);
      return (await repo.checks(monitorId, limit, region)).map((r) => ({
        id: r.id,
        checkedAt: r.checkedAt.toISOString(),
        region: r.region,
        ok: r.ok,
        errorCode: r.errorCode,
        httpStatus: r.httpStatus,
        latencyMs: r.latencyMs,
        message: r.message,
        timings: r.timings,
      }));
    },
  };
}
