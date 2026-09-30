/* Queries on outbox_events. No business logic; callers pass `tx` when inside a transaction. */
import { and, asc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { DbOrTx } from "../db/index.js";
import { outboxEvents, type OutboxEventRow } from "./schema.js";

export const OUTBOX_CHANNEL = "outbox";

export const outboxRepository = {
  async insert(
    tx: DbOrTx,
    row: Pick<
      OutboxEventRow,
      "id" | "workspaceId" | "type" | "version" | "payload" | "correlationId"
    >,
  ): Promise<void> {
    await tx.insert(outboxEvents).values(row);
  },

  /* Postgres delivers NOTIFY only when the surrounding transaction commits. */
  async notify(tx: DbOrTx): Promise<void> {
    await tx.execute(sql`select pg_notify(${OUTBOX_CHANNEL}, '')`);
  },

  /* Oldest undispatched rows, locked so parallel relays never claim the same row. */
  async claimBatch(tx: DbOrTx, limit: number): Promise<OutboxEventRow[]> {
    return tx
      .select()
      .from(outboxEvents)
      .where(isNull(outboxEvents.dispatchedAt))
      .orderBy(asc(outboxEvents.createdAt), asc(outboxEvents.id))
      .limit(limit)
      .for("update", { skipLocked: true });
  },

  async markDispatched(tx: DbOrTx, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await tx
      .update(outboxEvents)
      .set({ dispatchedAt: sql`now()` })
      .where(inArray(outboxEvents.id, ids));
  },

  async recordFailure(db: DbOrTx, ids: string[], error: string): Promise<void> {
    if (ids.length === 0) return;
    await db
      .update(outboxEvents)
      .set({ attempts: sql`${outboxEvents.attempts} + 1`, lastError: error.slice(0, 2_000) })
      .where(and(inArray(outboxEvents.id, ids), isNull(outboxEvents.dispatchedAt)));
  },

  async findById(db: DbOrTx, id: string): Promise<OutboxEventRow | undefined> {
    const rows = await db.select().from(outboxEvents).where(eq(outboxEvents.id, id)).limit(1);
    return rows[0];
  },

  async deleteDispatchedOlderThan(db: DbOrTx, seconds: number): Promise<number> {
    const rows = await db
      .delete(outboxEvents)
      .where(
        and(
          isNotNull(outboxEvents.dispatchedAt),
          lt(outboxEvents.dispatchedAt, sql`now() - make_interval(secs => ${seconds})`),
        ),
      )
      .returning({ id: outboxEvents.id });
    return rows.length;
  },

  /* Age in seconds of the oldest undispatched row; 0 when the outbox is empty. */
  async lagSeconds(db: DbOrTx): Promise<number> {
    const result = await db.execute<{ lag: string | number | null }>(
      sql`select extract(epoch from now() - min(${outboxEvents.createdAt})) as lag
          from ${outboxEvents} where ${outboxEvents.dispatchedAt} is null`,
    );
    const lag = result.rows[0]?.lag;
    return lag === null || lag === undefined ? 0 : Math.max(0, Number(lag));
  },
};
