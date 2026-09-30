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

/* The upsert every rollup level shares: recomputed buckets replace what was there (idempotent). */
const UPSERT = sql`on conflict (monitor_id, region, bucket) do update set
  workspace_id = excluded.workspace_id, count = excluded.count, fail_count = excluded.fail_count,
  ok_count = excluded.ok_count, latency_sum = excluded.latency_sum,
  latency_min = excluded.latency_min, latency_max = excluded.latency_max,
  histogram = excluded.histogram`;

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
        ),
        hist as (
          select monitor_id, region, bucket, hb, count(*)::int as c from raw where ok group by 1, 2, 3, 4
        ),
        agg as (
          select monitor_id, region, bucket, min(workspace_id::text)::uuid as workspace_id,
            count(*)::int as cnt, (count(*) filter (where not ok))::int as fails,
            (count(*) filter (where ok))::int as oks,
            coalesce(sum(latency_ms) filter (where ok), 0)::bigint as lsum,
            min(latency_ms) filter (where ok) as lmin, max(latency_ms) filter (where ok) as lmax
          from raw group by 1, 2, 3
        ),
        arrays as (
          select a.monitor_id, a.region, a.bucket, array_agg(coalesce(h.c, 0) order by s.i) as histogram
          from agg a
          cross join generate_series(0, ${HISTOGRAM_SIZE - 1}) as s(i)
          left join hist h on h.monitor_id = a.monitor_id and h.region = a.region
            and h.bucket = a.bucket and h.hb = s.i
          group by 1, 2, 3
        )
        insert into ${rollups5m} (monitor_id, region, bucket, workspace_id, count, fail_count, ok_count,
          latency_sum, latency_min, latency_max, histogram)
        select a.monitor_id, a.region, a.bucket, a.workspace_id, a.cnt, a.fails, a.oks, a.lsum, a.lmin,
          a.lmax, x.histogram
        from agg a
        join arrays x on x.monitor_id = a.monitor_id and x.region = a.region and x.bucket = a.bucket
        ${UPSERT}`);
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
        with src as (
          select *, date_trunc(${unit}, bucket, 'UTC') as target_bucket from ${source}
          where bucket >= ${from.toISOString()}::timestamptz and bucket < ${to.toISOString()}::timestamptz
        ),
        hist as (
          select monitor_id, region, target_bucket, u.i, sum(u.h)::int as s
          from src, unnest(histogram) with ordinality as u(h, i) group by 1, 2, 3, 4
        ),
        agg as (
          select monitor_id, region, target_bucket, min(workspace_id::text)::uuid as workspace_id,
            sum(count)::int as cnt, sum(fail_count)::int as fails, sum(ok_count)::int as oks,
            sum(latency_sum)::bigint as lsum, min(latency_min) as lmin, max(latency_max) as lmax
          from src group by 1, 2, 3
        ),
        arrays as (
          select a.monitor_id, a.region, a.target_bucket,
            array_agg(coalesce(h.s, 0) order by k.k) as histogram
          from agg a
          cross join generate_series(1, ${HISTOGRAM_SIZE}) as k(k)
          left join hist h on h.monitor_id = a.monitor_id and h.region = a.region
            and h.target_bucket = a.target_bucket and h.i = k.k
          group by 1, 2, 3
        )
        insert into ${target} (monitor_id, region, bucket, workspace_id, count, fail_count, ok_count,
          latency_sum, latency_min, latency_max, histogram)
        select a.monitor_id, a.region, a.target_bucket, a.workspace_id, a.cnt, a.fails, a.oks, a.lsum,
          a.lmin, a.lmax, x.histogram
        from agg a
        join arrays x on x.monitor_id = a.monitor_id and x.region = a.region
          and x.target_bucket = a.target_bucket
        ${UPSERT}`);
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
