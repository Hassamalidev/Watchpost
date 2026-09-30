/* Queries on monitor_state, monitor_region_state and downtimes, owned by the detection module. */
import { and, eq, isNull, sql } from "drizzle-orm";
import { assertWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import type { DbOrTx } from "../../infra/db/index.js";
import {
  downtimes,
  monitorRegionState,
  monitorState,
  type DowntimeRow,
  type MonitorStateRow,
  type RegionStatus,
} from "./schema/detection.js";

export type DetectionRepository = ReturnType<typeof createDetectionRepository>;

export interface RegionStateRow {
  monitorId: string;
  region: string;
  status: RegionStatus;
  lastResultAt: Date;
  lastErrorCode: string | null;
  lastLatencyMs: number | null;
}

export function createDetectionRepository() {
  return {
    /* Records that results arrived; creates the state row on a monitor's first result. */
    async noteResult(
      tx: DbOrTx,
      input: { monitorId: string; workspaceId: string; lastResultAt: Date },
    ): Promise<void> {
      await tx
        .insert(monitorState)
        .values({ ...input, status: "pending", since: input.lastResultAt })
        .onConflictDoUpdate({
          target: monitorState.monitorId,
          set: {
            lastResultAt: sql`greatest(${monitorState.lastResultAt}, excluded.last_result_at)`,
          },
        });
    },

    /*
     * Fast path (§9.2): healthy results for a healthy monitor need no evaluation. Marks them evaluated
     * only if the monitor is still plainly up; returns false when a full evaluation is needed.
     */
    async markEvaluatedIfHealthy(tx: DbOrTx, monitorId: string): Promise<boolean> {
      const rows = await tx
        .update(monitorState)
        .set({ lastEvaluatedAt: sql`${monitorState.lastResultAt}` })
        .where(
          and(
            eq(monitorState.monitorId, monitorId),
            eq(monitorState.status, "up"),
            isNull(monitorState.openIncidentId),
            isNull(monitorState.flappingUntil),
            isNull(monitorState.verifyRequestedAt),
          ),
        )
        .returning({ monitorId: monitorState.monitorId });
      return rows.length > 0;
    },

    async ensureState(tx: DbOrTx, monitorId: string, workspaceId: string): Promise<void> {
      await tx
        .insert(monitorState)
        .values({ monitorId, workspaceId })
        .onConflictDoNothing({ target: monitorState.monitorId });
    },

    async lockState(tx: DbOrTx, monitorId: string): Promise<MonitorStateRow | undefined> {
      const rows = await tx
        .select()
        .from(monitorState)
        .where(eq(monitorState.monitorId, monitorId))
        .for("update");
      return rows[0];
    },

    async statesForWorkspace(tx: DbOrTx, scope: WorkspaceScope): Promise<MonitorStateRow[]> {
      assertWorkspaceScope(scope);
      return tx.select().from(monitorState).where(eq(monitorState.workspaceId, scope.workspaceId));
    },

    async findState(tx: DbOrTx, monitorId: string): Promise<MonitorStateRow | undefined> {
      const rows = await tx
        .select()
        .from(monitorState)
        .where(eq(monitorState.monitorId, monitorId));
      return rows[0];
    },

    async updateState(
      tx: DbOrTx,
      monitorId: string,
      patch: Partial<typeof monitorState.$inferInsert>,
    ): Promise<void> {
      await tx
        .update(monitorState)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(eq(monitorState.monitorId, monitorId));
    },

    async upsertRegionStates(tx: DbOrTx, rows: RegionStateRow[]): Promise<void> {
      if (rows.length === 0) return;
      await tx
        .insert(monitorRegionState)
        .values(rows)
        .onConflictDoUpdate({
          target: [monitorRegionState.monitorId, monitorRegionState.region],
          set: {
            status: sql`excluded.status`,
            lastResultAt: sql`excluded.last_result_at`,
            lastErrorCode: sql`excluded.last_error_code`,
            lastLatencyMs: sql`excluded.last_latency_ms`,
          },
          /* Out-of-order batches must not move the cache backwards. */
          setWhere: sql`${monitorRegionState.lastResultAt} <= excluded.last_result_at`,
        });
    },

    async regionStates(tx: DbOrTx, monitorId: string) {
      return tx
        .select()
        .from(monitorRegionState)
        .where(eq(monitorRegionState.monitorId, monitorId));
    },

    async findOpenDowntime(tx: DbOrTx, monitorId: string): Promise<DowntimeRow | undefined> {
      const rows = await tx
        .select()
        .from(downtimes)
        .where(and(eq(downtimes.monitorId, monitorId), isNull(downtimes.endedAt)))
        .for("update");
      return rows[0];
    },

    async insertDowntime(tx: DbOrTx, row: typeof downtimes.$inferInsert): Promise<void> {
      await tx.insert(downtimes).values(row);
    },

    async closeDowntime(tx: DbOrTx, id: string, endedAt: Date): Promise<void> {
      await tx
        .update(downtimes)
        .set({
          endedAt: sql`greatest(${downtimes.startedAt}, ${endedAt.toISOString()}::timestamptz)`,
        })
        .where(eq(downtimes.id, id));
    },

    /* Outage seconds per monitor inside [from, to), most first. */
    async downtimeByMonitor(
      tx: DbOrTx,
      workspaceId: string,
      from: Date,
      to: Date,
      limit: number,
    ): Promise<Array<{ monitorId: string; seconds: number }>> {
      const fromIso = from.toISOString();
      const toIso = to.toISOString();
      const result = await tx.execute<{ monitor_id: string; seconds: string }>(sql`
        select monitor_id, sum(extract(epoch from
          least(coalesce(${downtimes.endedAt}, now()), ${toIso}::timestamptz)
          - greatest(${downtimes.startedAt}, ${fromIso}::timestamptz))) as seconds
        from ${downtimes}
        where ${downtimes.workspaceId} = ${workspaceId} and ${downtimes.kind} = 'outage'
          and ${downtimes.startedAt} < ${toIso}::timestamptz
          and (${downtimes.endedAt} is null or ${downtimes.endedAt} > ${fromIso}::timestamptz)
        group by monitor_id
        order by seconds desc
        limit ${limit}`);
      return result.rows.map((r) => ({
        monitorId: r.monitor_id,
        seconds: Math.max(0, Number(r.seconds)),
      }));
    },

    /* Downtimes overlapping [from, to). */
    async downtimesBetween(
      tx: DbOrTx,
      monitorId: string,
      from: Date,
      to: Date,
    ): Promise<DowntimeRow[]> {
      return tx
        .select()
        .from(downtimes)
        .where(
          and(
            eq(downtimes.monitorId, monitorId),
            sql`${downtimes.startedAt} < ${to.toISOString()}::timestamptz`,
            sql`(${downtimes.endedAt} is null or ${downtimes.endedAt} > ${from.toISOString()}::timestamptz)`,
          ),
        )
        .orderBy(downtimes.startedAt);
    },

    async downtimesFor(tx: DbOrTx, monitorId: string): Promise<DowntimeRow[]> {
      return tx
        .select()
        .from(downtimes)
        .where(eq(downtimes.monitorId, monitorId))
        .orderBy(downtimes.startedAt);
    },

    /* Monitors with results no evaluation has seen (the evaluate queue's recovery source). */
    async unevaluated(
      tx: DbOrTx,
      limit: number,
    ): Promise<Array<{ monitorId: string; lastResultAt: Date }>> {
      const rows = await tx
        .select({ monitorId: monitorState.monitorId, lastResultAt: monitorState.lastResultAt })
        .from(monitorState)
        .where(
          sql`${monitorState.lastResultAt} > coalesce(${monitorState.lastEvaluatedAt}, '-infinity'::timestamptz)`,
        )
        .limit(limit);
      return rows.flatMap((r) =>
        r.lastResultAt === null ? [] : [{ monitorId: r.monitorId, lastResultAt: r.lastResultAt }],
      );
    },
  };
}
