/* Queries on heartbeat_state, heartbeat_pings, platform_ticks and platform_gaps (heartbeats module). */
import { and, desc, eq, gte, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { DbOrTx } from "../../infra/db/index.js";
import {
  heartbeatPings,
  heartbeatState,
  platformGaps,
  platformTicks,
  type HeartbeatPingRow,
  type HeartbeatStateRow,
  type PlatformGapRow,
} from "./schema/heartbeats.js";

export type HeartbeatsRepository = ReturnType<typeof createHeartbeatsRepository>;
export type HeartbeatStatePatch = Partial<typeof heartbeatState.$inferInsert>;

export function createHeartbeatsRepository() {
  return {
    async findState(
      tx: DbOrTx,
      monitorId: string,
      lock = false,
    ): Promise<HeartbeatStateRow | undefined> {
      const query = tx.select().from(heartbeatState).where(eq(heartbeatState.monitorId, monitorId));
      const rows = lock ? await query.for("update") : await query;
      return rows[0];
    },

    async findByTokenHash(tx: DbOrTx, tokenHash: string): Promise<HeartbeatStateRow | undefined> {
      const rows = await tx
        .select()
        .from(heartbeatState)
        .where(eq(heartbeatState.tokenHash, tokenHash))
        .limit(1);
      return rows[0];
    },

    /* Creates the state with a new token, or replaces the token (rotation). */
    async upsertToken(tx: DbOrTx, row: typeof heartbeatState.$inferInsert): Promise<void> {
      await tx
        .insert(heartbeatState)
        .values(row)
        .onConflictDoUpdate({
          target: heartbeatState.monitorId,
          set: {
            tokenHash: row.tokenHash,
            schedule: row.schedule,
            graceSeconds: row.graceSeconds,
            maxDurationSeconds: row.maxDurationSeconds ?? null,
            updatedAt: sql`now()`,
          },
        });
    },

    async updateState(tx: DbOrTx, monitorId: string, patch: HeartbeatStatePatch): Promise<void> {
      await tx
        .update(heartbeatState)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(eq(heartbeatState.monitorId, monitorId));
    },

    async deleteState(tx: DbOrTx, monitorId: string): Promise<void> {
      await tx.delete(heartbeatState).where(eq(heartbeatState.monitorId, monitorId));
    },

    async insertPing(tx: DbOrTx, row: typeof heartbeatPings.$inferInsert): Promise<void> {
      await tx.insert(heartbeatPings).values(row);
    },

    async pings(tx: DbOrTx, monitorId: string, limit: number): Promise<HeartbeatPingRow[]> {
      return tx
        .select()
        .from(heartbeatPings)
        .where(eq(heartbeatPings.monitorId, monitorId))
        .orderBy(desc(heartbeatPings.at), desc(heartbeatPings.id))
        .limit(limit);
    },

    /* Heartbeats past their deadline plus grace, locked for this sweeper only (§9.7). */
    async dueMissed(tx: DbOrTx, now: Date, limit: number): Promise<HeartbeatStateRow[]> {
      return tx
        .select()
        .from(heartbeatState)
        .where(
          and(
            sql`${heartbeatState.status} in ('up', 'degraded')`,
            isNotNull(heartbeatState.nextExpectedAt),
            sql`${heartbeatState.nextExpectedAt} + make_interval(secs => ${heartbeatState.graceSeconds}) < ${now.toISOString()}::timestamptz`,
          ),
        )
        .limit(limit)
        .for("update", { skipLocked: true });
    },

    /* Runs still going after their maximum duration. */
    async dueTooLong(tx: DbOrTx, now: Date, limit: number): Promise<HeartbeatStateRow[]> {
      return tx
        .select()
        .from(heartbeatState)
        .where(
          and(
            eq(heartbeatState.status, "up"),
            isNotNull(heartbeatState.runningSince),
            isNotNull(heartbeatState.maxDurationSeconds),
            sql`${heartbeatState.runningSince} + make_interval(secs => ${heartbeatState.maxDurationSeconds}) < ${now.toISOString()}::timestamptz`,
          ),
        )
        .limit(limit)
        .for("update", { skipLocked: true });
    },

    /* Platform guard */

    /* Serializes platform ticks from several workers. */
    async lockPlatformTick(tx: DbOrTx): Promise<void> {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('platform-tick'))`);
    },

    async tick(tx: DbOrTx, source: string): Promise<Date | undefined> {
      const rows = await tx.select().from(platformTicks).where(eq(platformTicks.source, source));
      return rows[0]?.at;
    },

    async setTick(tx: DbOrTx, source: string, at: Date): Promise<void> {
      await tx
        .insert(platformTicks)
        .values({ source, at })
        .onConflictDoUpdate({ target: platformTicks.source, set: { at } });
    },

    async openGap(
      tx: DbOrTx,
      reason: PlatformGapRow["reason"],
    ): Promise<PlatformGapRow | undefined> {
      const rows = await tx
        .select()
        .from(platformGaps)
        .where(and(eq(platformGaps.reason, reason), isNull(platformGaps.endedAt)))
        .for("update");
      return rows[0];
    },

    async insertGap(tx: DbOrTx, row: typeof platformGaps.$inferInsert): Promise<void> {
      await tx.insert(platformGaps).values(row).onConflictDoNothing();
    },

    async closeGap(tx: DbOrTx, id: string, endedAt: Date): Promise<void> {
      await tx.update(platformGaps).set({ endedAt }).where(eq(platformGaps.id, id));
    },

    /* Gaps still open or ended after `since`. */
    async gapsSince(tx: DbOrTx, since: Date): Promise<PlatformGapRow[]> {
      return tx
        .select()
        .from(platformGaps)
        .where(or(isNull(platformGaps.endedAt), gte(platformGaps.endedAt, since)));
    },
  };
}
