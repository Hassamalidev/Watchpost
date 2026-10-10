/* Queries on probes and probe_tasks, owned by the probes module. */
import type { ProbeTaskKind } from "@app/shared";
import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { assertWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import type { DbOrTx } from "../../infra/db/index.js";
import { probeTasks, probes, type ProbeRow, type ProbeTaskRow } from "./schema/probes.js";
import { TASK_CHANNEL } from "./types/task-notifier.js";

export type ProbesRepository = ReturnType<typeof createProbesRepository>;

export function createProbesRepository(db: DbOrTx) {
  return {
    async insertProbe(row: typeof probes.$inferInsert): Promise<ProbeRow> {
      const [created] = await db.insert(probes).values(row).returning();
      if (created === undefined) throw new Error("probe insert returned no row");
      return created;
    },

    async findProbe(id: string): Promise<ProbeRow | undefined> {
      const rows = await db.select().from(probes).where(eq(probes.id, id)).limit(1);
      return rows[0];
    },

    /* Regions with a probe seen since `seenAfter` and not quarantined at `now`. */
    async healthyRegions(input: {
      regions: string[];
      workspaceId: string;
      seenAfter: Date;
      now: Date;
    }): Promise<string[]> {
      if (input.regions.length === 0) return [];
      const rows = await db
        .selectDistinct({ region: probes.region })
        .from(probes)
        .where(
          and(
            inArray(probes.region, input.regions),
            gt(probes.lastSeenAt, input.seenAfter),
            or(isNull(probes.quarantinedUntil), lte(probes.quarantinedUntil, input.now)),
            or(eq(probes.kind, "managed"), eq(probes.workspaceId, input.workspaceId)),
          ),
        );
      return rows.map((r) => r.region);
    },

    /* Probe health guard: ignore this probe's failures until `until`. True if it wasn't already. */
    async quarantine(id: string, until: Date, now: Date): Promise<boolean> {
      const [before] = await db
        .select({ quarantinedUntil: probes.quarantinedUntil })
        .from(probes)
        .where(eq(probes.id, id))
        .limit(1);
      await db.update(probes).set({ quarantinedUntil: until }).where(eq(probes.id, id));
      return (
        before === undefined || before.quarantinedUntil === null || before.quarantinedUntil <= now
      );
    },

    /* Our own probes, switched on, that reported since `seenAfter`. */
    async managedProbes(seenAfter: Date): Promise<ProbeRow[]> {
      return db
        .select()
        .from(probes)
        .where(
          and(
            eq(probes.kind, "managed"),
            eq(probes.disabled, false),
            gt(probes.lastSeenAt, seenAfter),
          ),
        );
    },

    async listProbes(): Promise<ProbeRow[]> {
      return db.select().from(probes).orderBy(probes.region, probes.name);
    },

    async touch(
      id: string,
      patch: { version?: string; lastHeartbeat?: Record<string, unknown> },
    ): Promise<void> {
      await db
        .update(probes)
        .set({ ...patch, lastSeenAt: sql`now()`, offlineNotifiedAt: null })
        .where(eq(probes.id, id));
    },

    /* A workspace's private probes, oldest first. */
    async privateProbes(scope: WorkspaceScope): Promise<ProbeRow[]> {
      assertWorkspaceScope(scope);
      return db
        .select()
        .from(probes)
        .where(and(eq(probes.kind, "private"), eq(probes.workspaceId, scope.workspaceId)))
        .orderBy(probes.createdAt, probes.id);
    },

    async setRegion(id: string, region: string): Promise<void> {
      await db.update(probes).set({ region }).where(eq(probes.id, id));
    },

    async deletePrivateProbe(scope: WorkspaceScope, id: string): Promise<boolean> {
      assertWorkspaceScope(scope);
      const rows = await db
        .delete(probes)
        .where(
          and(
            eq(probes.id, id),
            eq(probes.kind, "private"),
            eq(probes.workspaceId, scope.workspaceId),
          ),
        )
        .returning({ id: probes.id });
      return rows.length > 0;
    },

    /*
     * System: private probes that reported once, have been silent since `before`, and whose
     * workspace hasn't been told. Marks them as told and returns them, so two workers tell once.
     */
    async claimSilentPrivateProbes(before: Date, now: Date): Promise<ProbeRow[]> {
      return db
        .update(probes)
        .set({ offlineNotifiedAt: now })
        .where(
          and(
            eq(probes.kind, "private"),
            eq(probes.disabled, false),
            isNull(probes.offlineNotifiedAt),
            lte(probes.lastSeenAt, before),
          ),
        )
        .returning();
    },

    /* Inserts a task unless one with the same dedupe key exists; announces it after commit. */
    async insertTask(tx: DbOrTx, row: typeof probeTasks.$inferInsert, notifyKey: string) {
      const [created] = await tx
        .insert(probeTasks)
        .values(row)
        .onConflictDoNothing({ target: probeTasks.dedupeKey })
        .returning();
      if (created) await tx.execute(sql`select pg_notify(${TASK_CHANNEL}, ${notifyKey})`);
      return created;
    },

    /* Atomically claims up to `limit` unexpired, unclaimed tasks for a probe. */
    async claimTasks(
      probeId: string,
      filter: { region: string; workspaceId: string | null; kinds: readonly ProbeTaskKind[] },
      limit: number,
    ): Promise<ProbeTaskRow[]> {
      const kinds = sql.join(
        filter.kinds.map((kind) => sql`${kind}`),
        sql`, `,
      );
      const workspaceFilter =
        filter.workspaceId === null ? sql`` : sql`and workspace_id = ${filter.workspaceId}`;
      const result = await db.execute<Record<string, unknown>>(sql`
        update ${probeTasks} set claimed_by = ${probeId}, claimed_at = now()
        where id in (
          select id from ${probeTasks}
          where claimed_by is null and region = ${filter.region} and expires_at > now()
            and kind in (${kinds}) ${workspaceFilter}
          order by created_at
          limit ${limit}
          for update skip locked
        )
        returning id`);
      const ids = result.rows.map((r) => String(r.id));
      if (ids.length === 0) return [];
      return db.select().from(probeTasks).where(inArray(probeTasks.id, ids));
    },

    async completeTasks(
      tx: DbOrTx,
      probeId: string,
      done: Array<{ taskId: string; resultId: string; result: Record<string, unknown> }>,
    ): Promise<void> {
      for (const { taskId, resultId, result } of done) {
        await tx
          .update(probeTasks)
          .set({ completedAt: sql`now()`, resultId, result })
          .where(
            and(
              eq(probeTasks.id, taskId),
              eq(probeTasks.claimedBy, probeId),
              isNull(probeTasks.completedAt),
            ),
          );
      }
    },

    /* Closes a diagnose task this probe claimed; undefined when it isn't one, or is done. */
    async completeDiagnosis(
      probeId: string,
      taskId: string,
      result: Record<string, unknown>,
    ): Promise<ProbeTaskRow | undefined> {
      const [row] = await db
        .update(probeTasks)
        .set({ completedAt: sql`now()`, result })
        .where(
          and(
            eq(probeTasks.id, taskId),
            eq(probeTasks.claimedBy, probeId),
            eq(probeTasks.kind, "diagnose"),
            isNull(probeTasks.completedAt),
          ),
        )
        .returning();
      return row;
    },

    async findTask(scope: WorkspaceScope, taskId: string): Promise<ProbeTaskRow | undefined> {
      assertWorkspaceScope(scope);
      const rows = await db
        .select()
        .from(probeTasks)
        .where(and(eq(probeTasks.id, taskId), eq(probeTasks.workspaceId, scope.workspaceId)))
        .limit(1);
      return rows[0];
    },
  };
}
