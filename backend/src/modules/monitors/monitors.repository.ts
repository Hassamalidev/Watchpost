/* Drizzle queries for the monitors module's own tables. Every tenant query filters by workspace. */
import { and, asc, desc, eq, gt, ilike, inArray, lt, ne, sql, type SQL } from "drizzle-orm";
import { assertWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import type { DbOrTx } from "../../infra/db/index.js";
import {
  monitorConfigChanges,
  monitorGroups,
  monitorTags,
  monitors,
  tags,
  type MonitorGroupRow,
  type MonitorRow,
} from "./schema/monitors.js";

export interface ListFilters {
  limit: number;
  cursor?: string | undefined;
  tag?: string | undefined;
  groupId?: string | undefined;
  type?: string | undefined;
  paused?: boolean | undefined;
  q?: string | undefined;
}

export type NewMonitorRow = typeof monitors.$inferInsert;

export type MonitorsRepository = ReturnType<typeof createMonitorsRepository>;

const scoped = (scope: WorkspaceScope, ...conditions: Array<SQL | undefined>) => {
  assertWorkspaceScope(scope);
  return and(eq(monitors.workspaceId, scope.workspaceId), ...conditions);
};

export function createMonitorsRepository(db: DbOrTx) {
  return {
    /* Serializes limit checks and creates within one workspace for the rest of the transaction. */
    async lockWorkspace(tx: DbOrTx, scope: WorkspaceScope): Promise<void> {
      assertWorkspaceScope(scope);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${scope.workspaceId}, 7))`,
      );
    },

    async countByKind(
      tx: DbOrTx,
      scope: WorkspaceScope,
      kind: "heartbeat" | "monitor",
      excludeId?: string,
    ): Promise<number> {
      const rows = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(monitors)
        .where(
          scoped(
            scope,
            kind === "heartbeat" ? eq(monitors.type, "heartbeat") : ne(monitors.type, "heartbeat"),
            eq(monitors.paused, false),
            excludeId ? ne(monitors.id, excludeId) : undefined,
          ),
        );
      return rows[0]?.n ?? 0;
    },

    /* Every monitor of the workspace, oldest first (UUIDv7 IDs sort by creation time). */
    async allForWorkspace(tx: DbOrTx, scope: WorkspaceScope): Promise<MonitorRow[]> {
      return tx.select().from(monitors).where(scoped(scope)).orderBy(asc(monitors.id));
    },

    async countPausedByPlan(tx: DbOrTx, scope: WorkspaceScope): Promise<number> {
      const rows = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(monitors)
        .where(scoped(scope, eq(monitors.paused, true), eq(monitors.pausedReason, "plan_limit")));
      return rows[0]?.n ?? 0;
    },

    async insert(tx: DbOrTx, row: NewMonitorRow): Promise<MonitorRow> {
      const [created] = await tx.insert(monitors).values(row).returning();
      if (created === undefined) throw new Error("insert returned no row");
      return created;
    },

    async update(
      tx: DbOrTx,
      scope: WorkspaceScope,
      id: string,
      patch: Partial<NewMonitorRow>,
    ): Promise<MonitorRow | undefined> {
      const { workspaceId: _ignored, id: _id, ...safe } = patch;
      const [row] = await tx
        .update(monitors)
        .set({ ...safe, updatedAt: sql`now()` })
        .where(scoped(scope, eq(monitors.id, id)))
        .returning();
      return row;
    },

    async delete(tx: DbOrTx, scope: WorkspaceScope, id: string): Promise<MonitorRow | undefined> {
      const [row] = await tx
        .delete(monitors)
        .where(scoped(scope, eq(monitors.id, id)))
        .returning();
      return row;
    },

    async find(tx: DbOrTx, scope: WorkspaceScope, id: string, forUpdate = false) {
      const query = tx
        .select()
        .from(monitors)
        .where(scoped(scope, eq(monitors.id, id)))
        .limit(1);
      const rows = forUpdate ? await query.for("update") : await query;
      return rows[0];
    },

    async list(scope: WorkspaceScope, filters: ListFilters): Promise<MonitorRow[]> {
      const tagFilter = filters.tag
        ? sql`exists (select 1 from ${monitorTags} mt join ${tags} t on t.id = mt.tag_id
              where mt.monitor_id = ${monitors.id} and t.name = ${filters.tag})`
        : undefined;
      return db
        .select()
        .from(monitors)
        .where(
          scoped(
            scope,
            filters.cursor ? lt(monitors.id, filters.cursor) : undefined,
            filters.groupId ? eq(monitors.groupId, filters.groupId) : undefined,
            filters.type ? eq(monitors.type, filters.type as MonitorRow["type"]) : undefined,
            filters.paused === undefined ? undefined : eq(monitors.paused, filters.paused),
            filters.q
              ? ilike(monitors.name, `%${filters.q.replace(/[%_\\]/g, "\\$&")}%`)
              : undefined,
            tagFilter,
          ),
        )
        .orderBy(desc(monitors.id))
        .limit(filters.limit);
    },

    /* IDs of every ancestor of a monitor (parent, grandparent, …), for cycle checks. */
    async ancestorIds(tx: DbOrTx, scope: WorkspaceScope, startId: string): Promise<string[]> {
      assertWorkspaceScope(scope);
      const result = await tx.execute<{ id: string }>(sql`
        with recursive chain(id, parent_id, depth) as (
          select id, parent_id, 0 from ${monitors}
          where id = ${startId} and workspace_id = ${scope.workspaceId}
          union all
          select m.id, m.parent_id, c.depth + 1 from ${monitors} m
          join chain c on m.id = c.parent_id
          where m.workspace_id = ${scope.workspaceId} and c.depth < 50
        )
        select id from chain`);
      return result.rows.map((r) => r.id);
    },

    async appendChange(
      tx: DbOrTx,
      change: { monitorId: string; workspaceId: string; op: "upsert" | "delete" },
    ): Promise<number> {
      /*
       * One writer at a time until commit, so `seq` order is commit order. Without it a later seq can
       * commit first, a probe's cursor moves past it, and the earlier change is never delivered.
       */
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('monitor-config-changes'))`);
      const [row] = await tx.insert(monitorConfigChanges).values(change).returning({
        seq: monitorConfigChanges.seq,
      });
      if (row === undefined) throw new Error("change insert returned no row");
      return row.seq;
    },

    async changesSince(afterSeq: number, limit: number) {
      return db
        .select()
        .from(monitorConfigChanges)
        .where(gt(monitorConfigChanges.seq, afterSeq))
        .orderBy(asc(monitorConfigChanges.seq))
        .limit(limit);
    },

    async latestSeq(): Promise<number> {
      const rows = await db
        .select({ seq: sql<number>`coalesce(max(${monitorConfigChanges.seq}), 0)::bigint` })
        .from(monitorConfigChanges);
      return Number(rows[0]?.seq ?? 0);
    },

    /* System-level read for probe assignments (no tenant scope: probes see many workspaces). */
    async changeTimes(monitorId: string, from: Date, to: Date): Promise<Date[]> {
      const rows = await db
        .select({ at: monitorConfigChanges.createdAt })
        .from(monitorConfigChanges)
        .where(
          and(
            eq(monitorConfigChanges.monitorId, monitorId),
            sql`${monitorConfigChanges.createdAt} >= ${from.toISOString()}::timestamptz`,
            sql`${monitorConfigChanges.createdAt} < ${to.toISOString()}::timestamptz`,
          ),
        )
        .orderBy(asc(monitorConfigChanges.seq));
      return rows.map((r) => r.at);
    },

    async findByIdsUnscoped(ids: string[]): Promise<MonitorRow[]> {
      if (ids.length === 0) return [];
      return db.select().from(monitors).where(inArray(monitors.id, ids));
    },

    async byTypeUnscoped(
      types: MonitorRow["type"][],
      limit: number,
      afterId?: string,
    ): Promise<MonitorRow[]> {
      return db
        .select()
        .from(monitors)
        .where(and(inArray(monitors.type, types), afterId ? gt(monitors.id, afterId) : undefined))
        .orderBy(asc(monitors.id))
        .limit(limit);
    },

    async activeUnscoped(limit: number, afterId?: string): Promise<MonitorRow[]> {
      return db
        .select()
        .from(monitors)
        .where(and(eq(monitors.paused, false), afterId ? gt(monitors.id, afterId) : undefined))
        .orderBy(asc(monitors.id))
        .limit(limit);
    },

    /* Tags */
    async upsertTags(tx: DbOrTx, scope: WorkspaceScope, names: string[], newId: () => string) {
      assertWorkspaceScope(scope);
      if (names.length === 0) return [];
      await tx
        .insert(tags)
        .values(names.map((name) => ({ id: newId(), workspaceId: scope.workspaceId, name })))
        .onConflictDoNothing({ target: [tags.workspaceId, tags.name] });
      return tx
        .select({ id: tags.id, name: tags.name })
        .from(tags)
        .where(and(eq(tags.workspaceId, scope.workspaceId), inArray(tags.name, names)));
    },

    async setMonitorTags(tx: DbOrTx, monitorId: string, tagIds: string[]): Promise<void> {
      await tx.delete(monitorTags).where(eq(monitorTags.monitorId, monitorId));
      if (tagIds.length > 0) {
        await tx.insert(monitorTags).values(tagIds.map((tagId) => ({ monitorId, tagId })));
      }
    },

    async tagsFor(tx: DbOrTx, monitorIds: string[]): Promise<Map<string, string[]>> {
      const map = new Map<string, string[]>();
      if (monitorIds.length === 0) return map;
      const rows = await tx
        .select({ monitorId: monitorTags.monitorId, name: tags.name })
        .from(monitorTags)
        .innerJoin(tags, eq(tags.id, monitorTags.tagId))
        .where(inArray(monitorTags.monitorId, monitorIds))
        .orderBy(asc(tags.name));
      for (const row of rows) map.set(row.monitorId, [...(map.get(row.monitorId) ?? []), row.name]);
      return map;
    },

    async listTags(scope: WorkspaceScope) {
      assertWorkspaceScope(scope);
      return db
        .select({ id: tags.id, name: tags.name })
        .from(tags)
        .where(eq(tags.workspaceId, scope.workspaceId))
        .orderBy(asc(tags.name));
    },

    /* Groups */
    async insertGroup(
      tx: DbOrTx,
      row: typeof monitorGroups.$inferInsert,
    ): Promise<MonitorGroupRow | undefined> {
      const [created] = await tx
        .insert(monitorGroups)
        .values(row)
        .onConflictDoNothing({ target: [monitorGroups.workspaceId, monitorGroups.name] })
        .returning();
      return created;
    },

    async findGroup(tx: DbOrTx, scope: WorkspaceScope, id: string) {
      assertWorkspaceScope(scope);
      const rows = await tx
        .select()
        .from(monitorGroups)
        .where(and(eq(monitorGroups.workspaceId, scope.workspaceId), eq(monitorGroups.id, id)))
        .limit(1);
      return rows[0];
    },

    async listGroups(scope: WorkspaceScope) {
      assertWorkspaceScope(scope);
      return db
        .select()
        .from(monitorGroups)
        .where(eq(monitorGroups.workspaceId, scope.workspaceId))
        .orderBy(asc(monitorGroups.name));
    },

    /* System: the groups of monitors detection and alerting are looking at. */
    async groupsByIdsUnscoped(ids: string[]): Promise<MonitorGroupRow[]> {
      if (ids.length === 0) return [];
      return db.select().from(monitorGroups).where(inArray(monitorGroups.id, ids));
    },

    async updateGroup(
      scope: WorkspaceScope,
      id: string,
      patch: { name: string; groupAlerts?: boolean | undefined },
    ) {
      assertWorkspaceScope(scope);
      const [row] = await db
        .update(monitorGroups)
        .set({
          name: patch.name,
          ...(patch.groupAlerts === undefined ? {} : { groupAlerts: patch.groupAlerts }),
        })
        .where(and(eq(monitorGroups.workspaceId, scope.workspaceId), eq(monitorGroups.id, id)))
        .returning();
      return row;
    },

    async deleteGroup(scope: WorkspaceScope, id: string): Promise<boolean> {
      assertWorkspaceScope(scope);
      const rows = await db
        .delete(monitorGroups)
        .where(and(eq(monitorGroups.workspaceId, scope.workspaceId), eq(monitorGroups.id, id)))
        .returning({ id: monitorGroups.id });
      return rows.length > 0;
    },
  };
}
