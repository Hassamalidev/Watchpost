/* Queries on check_results (partitioned) and check_events, owned by the results module. */
import { and, desc, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "../../infra/db/index.js";
import { checkEvents } from "./schema/check-events.js";
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

export function createResultsRepository(db: DbOrTx) {
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
