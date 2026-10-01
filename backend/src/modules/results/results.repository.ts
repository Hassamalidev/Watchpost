/* Queries on check_results (partitioned) and check_events, owned by the results module. */
import { and, desc, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "../../infra/db/index.js";
import { HISTOGRAM_SIZE, LATENCY_BOUNDS_MS } from "./histogram.js";
import { checkEvents } from "./schema/check-events.js";
import { rollups1d, rollups1h, rollups5m, type RollupRow } from "./schema/rollups.js";
import { checkResults, type CheckResultRow } from "./schema/partitioned/check-results.js";

export type NewCheckResult = typeof checkResults.$inferInsert;
export type NewCheckEvent = typeof checkEvents.$inferInsert;

const PARTITION_NAME = /^check_results_p(\d{4})(\d{2})(\d{2})$/;

export function partitionName(day: Date): string {
  return `check_results_p${day.toISOString().slice(0, 10).replaceAll("-", "")}`;
}

/* Start of the UTC day a partition covers, from its name. */
export function partitionDay(name: string): Date | undefined {
  const m = PARTITION_NAME.exec(name);
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : undefined;
}

export type ResultsRepository = ReturnType<typeof createResultsRepository>;
export type RollupSize = "5m" | "1h" | "1d";

const ROLLUP_TABLES = { "5m": rollups5m, "1h": rollups1h, "1d": rollups1d } as const;
const BOUNDS = sql.raw(`array[${LATENCY_BOUNDS_MS.join(",")}]::int[]`);

/*
 * Histograms in one GROUP BY pass (no unnest/join): a filtered count per latency bucket from raw
 * results, and an element-wise sum for larger rollups. Postgres arrays are 1-based.
 */
const RAW_HISTOGRAM = sql.raw(
  `array[${Array.from({ length: HISTOGRAM_SIZE }, (_, i) => `(count(*) filter (where ok and hb = ${i}))::int`).join(", ")}]`,
);
const SUMMED_HISTOGRAM = sql.raw(
  `array[${Array.from({ length: HISTOGRAM_SIZE }, (_, i) => `coalesce(sum(histogram[${i + 1}]), 0)::int`).join(", ")}]`,
);

/*
 * The upsert every rollup level shares: recomputed buckets replace what was there (idempotent), and
 * unchanged rows aren't rewritten.
 */
const upsert = (table: (typeof ROLLUP_TABLES)[RollupSize]) => sql`
  on conflict (monitor_id, region, bucket) do update set
  workspace_id = excluded.workspace_id, count = excluded.count, fail_count = excluded.fail_count,
  ok_count = excluded.ok_count, latency_sum = excluded.latency_sum,
  latency_min = excluded.latency_min, latency_max = excluded.latency_max,
  histogram = excluded.histogram
  where (${table}.count, ${table}.fail_count, ${table}.ok_count, ${table}.latency_sum,
    ${table}.latency_min, ${table}.latency_max, ${table}.histogram)
    is distinct from (excluded.count, excluded.fail_count, excluded.ok_count, excluded.latency_sum,
      excluded.latency_min, excluded.latency_max, excluded.histogram)`;

export function createResultsRepository(db: DbOrTx) {
  /*
   * Rollups run one at a time per level (a second run skips instead of queueing behind the first's
   * row locks) and are cut off after two minutes rather than running on.
   */
  async function guarded(key: string, work: (tx: DbOrTx) => Promise<number>): Promise<number> {
    return db.transaction(async (tx) => {
      const lock = await tx.execute<{ ok: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtext(${key})) as ok`,
      );
      if (lock.rows[0]?.ok !== true) return 0;
      await tx.execute(sql`set local statement_timeout = '120s'`);
      return work(tx);
    });
  }

  return {
    /* Returns the IDs actually inserted (duplicates are skipped by the primary key). */
    async insertResults(tx: DbOrTx, rows: NewCheckResult[]): Promise<string[]> {
      if (rows.length === 0) return [];
      const inserted = await tx
        .insert(checkResults)
        .values(rows)
        .onConflictDoNothing()
        .returning({ id: checkResults.id });
      return inserted.map((r) => r.id);
    },

    async insertEvents(tx: DbOrTx, rows: NewCheckEvent[]): Promise<void> {
      if (rows.length === 0) return;
      await tx.insert(checkEvents).values(rows).onConflictDoNothing({ target: checkEvents.id });
    },

    /* Latest results for one monitor in one region (uses check_results_monitor_region_at_idx). */
    async recent(monitorId: string, region: string, limit: number): Promise<CheckResultRow[]> {
      return db
        .select()
        .from(checkResults)
        .where(and(eq(checkResults.monitorId, monitorId), eq(checkResults.region, region)))
        .orderBy(desc(checkResults.checkedAt))
        .limit(limit);
    },

    /* The newest TLS facts per monitor from raw results (the last 48 h). */
    async latestTls(): Promise<
      Array<{
        monitorId: string;
        workspaceId: string;
        checkedAt: Date;
        tls: NonNullable<CheckResultRow["tls"]>;
      }>
    > {
      const result = await db.execute<{
        monitor_id: string;
        workspace_id: string;
        checked_at: string;
        tls: NonNullable<CheckResultRow["tls"]>;
      }>(sql`
        select distinct on (monitor_id) monitor_id, workspace_id, checked_at, tls
        from ${checkResults}
        where tls is not null
        order by monitor_id, checked_at desc`);
      return result.rows.map((r) => ({
        monitorId: r.monitor_id,
        workspaceId: r.workspace_id,
        checkedAt: new Date(r.checked_at),
        tls: r.tls,
      }));
    },

    /* 5-minute rollups for [from, to) straight from raw results. Returns rows written. */
    async rollupRaw(from: Date, to: Date): Promise<number> {
      return guarded("rollup-5m", async (tx) => {
        const result = await tx.execute(sql`
        with raw as (
          select monitor_id, region, workspace_id, ok, latency_ms,
            date_bin('5 minutes', checked_at, timestamptz '2000-01-01 00:00:00+00') as bucket,
            width_bucket(latency_ms, ${BOUNDS}) as hb
          from ${checkResults}
          where checked_at >= ${from.toISOString()}::timestamptz and checked_at < ${to.toISOString()}::timestamptz
        )
        insert into ${rollups5m} (monitor_id, region, bucket, workspace_id, count, fail_count, ok_count,
          latency_sum, latency_min, latency_max, histogram)
        select monitor_id, region, bucket, min(workspace_id::text)::uuid,
          count(*)::int, (count(*) filter (where not ok))::int, (count(*) filter (where ok))::int,
          coalesce(sum(latency_ms) filter (where ok), 0)::bigint,
          min(latency_ms) filter (where ok), max(latency_ms) filter (where ok),
          ${RAW_HISTOGRAM}
        from raw
        group by monitor_id, region, bucket
        ${upsert(rollups5m)}`);
        return result.rowCount ?? 0;
      });
    },

    /* Hourly rollups from 5-minute ones, or daily from hourly (UTC days), for [from, to). */
    async rollupFrom(size: "1h" | "1d", from: Date, to: Date): Promise<number> {
      const source = size === "1h" ? rollups5m : rollups1h;
      const target = ROLLUP_TABLES[size];
      const unit = sql.raw(size === "1h" ? "'hour'" : "'day'");
      return guarded(`rollup-${size}`, async (tx) => {
        const result = await tx.execute(sql`
        insert into ${target} (monitor_id, region, bucket, workspace_id, count, fail_count, ok_count,
          latency_sum, latency_min, latency_max, histogram)
        select monitor_id, region, date_trunc(${unit}, bucket, 'UTC'), min(workspace_id::text)::uuid,
          sum(count)::int, sum(fail_count)::int, sum(ok_count)::int, sum(latency_sum)::bigint,
          min(latency_min), max(latency_max), ${SUMMED_HISTOGRAM}
        from ${source}
        where bucket >= ${from.toISOString()}::timestamptz and bucket < ${to.toISOString()}::timestamptz
        group by monitor_id, region, date_trunc(${unit}, bucket, 'UTC')
        ${upsert(target)}`);
        return result.rowCount ?? 0;
      });
    },

    async deleteRollupsBefore(size: RollupSize, before: Date): Promise<number> {
      const table = ROLLUP_TABLES[size];
      const deleted = await db
        .delete(table)
        .where(sql`${table.bucket} < ${before.toISOString()}::timestamptz`)
        .returning({ bucket: table.bucket });
      return deleted.length;
    },

    async rollups(
      size: RollupSize,
      monitorId: string,
      from: Date,
      to: Date,
      region?: string,
    ): Promise<RollupRow[]> {
      const table = ROLLUP_TABLES[size];
      return db
        .select()
        .from(table)
        .where(
          and(
            eq(table.monitorId, monitorId),
            sql`${table.bucket} >= ${from.toISOString()}::timestamptz`,
            sql`${table.bucket} < ${to.toISOString()}::timestamptz`,
            region ? eq(table.region, region) : undefined,
          ),
        )
        .orderBy(table.bucket);
    },

    /* Addresses each region connected to in [from, to), with first and last time seen. */
    async ipHistory(monitorId: string, from: Date, to: Date) {
      const result = await db.execute<{
        region: string;
        ip: string;
        first_seen: string;
        last_seen: string;
      }>(sql`
        select region, ip, min(checked_at) as first_seen, max(checked_at) as last_seen
        from ${checkResults}
        where monitor_id = ${monitorId} and ip is not null
          and checked_at >= ${from.toISOString()}::timestamptz and checked_at < ${to.toISOString()}::timestamptz
        group by region, ip
        order by region, min(checked_at)`);
      return result.rows.map((r) => ({
        region: r.region,
        ip: r.ip,
        firstSeen: new Date(r.first_seen),
        lastSeen: new Date(r.last_seen),
      }));
    },

    /* Certificates each region saw in [from, to), by fingerprint, with first time seen. */
    async tlsHistory(monitorId: string, from: Date, to: Date) {
      const result = await db.execute<{
        region: string;
        fingerprint: string;
        issuer: string | null;
        valid_to: string | null;
        first_seen: string;
      }>(sql`
        select region, tls->>'fingerprint256' as fingerprint, min(tls->>'issuer') as issuer,
          max(tls->>'validTo') as valid_to, min(checked_at) as first_seen
        from ${checkResults}
        where monitor_id = ${monitorId} and tls is not null
          and checked_at >= ${from.toISOString()}::timestamptz and checked_at < ${to.toISOString()}::timestamptz
        group by region, tls->>'fingerprint256'
        order by region, min(checked_at)`);
      return result.rows.map((r) => ({
        region: r.region,
        fingerprint: r.fingerprint,
        issuer: r.issuer,
        validTo: r.valid_to,
        firstSeen: new Date(r.first_seen),
      }));
    },

    /* Mean latency of successful checks in [from, to). */
    async latencyAverage(
      monitorId: string,
      from: Date,
      to: Date,
    ): Promise<{ averageMs: number | null; count: number }> {
      const result = await db.execute<{ avg: string | null; n: number }>(sql`
        select avg(latency_ms) as avg, count(*)::int as n from ${checkResults}
        where monitor_id = ${monitorId} and ok
          and checked_at >= ${from.toISOString()}::timestamptz and checked_at < ${to.toISOString()}::timestamptz`);
      const row = result.rows[0];
      return {
        averageMs: row?.avg === null || row?.avg === undefined ? null : Number(row.avg),
        count: row?.n ?? 0,
      };
    },

    async checks(monitorId: string, limit: number, region?: string): Promise<CheckResultRow[]> {
      return db
        .select()
        .from(checkResults)
        .where(
          and(
            eq(checkResults.monitorId, monitorId),
            region ? eq(checkResults.region, region) : undefined,
          ),
        )
        .orderBy(desc(checkResults.checkedAt))
        .limit(limit);
    },

    async events(monitorId: string, limit: number) {
      return db
        .select()
        .from(checkEvents)
        .where(eq(checkEvents.monitorId, monitorId))
        .orderBy(desc(checkEvents.at))
        .limit(limit);
    },

    async listPartitions(): Promise<string[]> {
      const result = await db.execute<{ name: string }>(sql`
        select c.relname as name from pg_inherits i
        join pg_class c on c.oid = i.inhrelid
        join pg_class p on p.oid = i.inhparent
        where p.relname = 'check_results'
        order by c.relname`);
      return result.rows.map((r) => r.name);
    },

    async createPartition(day: Date): Promise<boolean> {
      const name = partitionName(day);
      const from = day.toISOString();
      const to = new Date(day.getTime() + 86_400_000).toISOString();
      const result = await db.execute<{ created: boolean }>(sql`
        select not exists (select 1 from pg_class where relname = ${name}) as created`);
      await db.execute(
        sql.raw(
          `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF check_results FOR VALUES FROM ('${from}') TO ('${to}')`,
        ),
      );
      return Boolean(result.rows[0]?.created);
    },

    async dropPartition(name: string): Promise<void> {
      if (!PARTITION_NAME.test(name)) throw new Error(`refusing to drop "${name}"`);
      await db.execute(sql.raw(`DROP TABLE IF EXISTS "${name}"`));
    },
  };
}
