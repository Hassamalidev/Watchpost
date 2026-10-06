/* Drizzle queries for this module's own tables only (tables go in schema/). */
import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import { tenantWhere, withWorkspace, type DbOrTx } from "../../infra/db/index.js";
import {
  escalationPolicies,
  oncallFeeds,
  scheduleLayers,
  scheduleOverrides,
  schedules,
  shiftNotices,
  type EscalationPolicyRow,
  type OncallFeedRow,
  type ScheduleLayerRow,
  type ScheduleOverrideRow,
  type ScheduleRow,
} from "./schema/oncall.js";

export type OncallRepository = ReturnType<typeof createOncallRepository>;

export type NewLayer = Omit<ScheduleLayerRow, "workspaceId" | "scheduleId" | "position">;

export function createOncallRepository() {
  return {
    async listSchedules(db: DbOrTx, scope: WorkspaceScope): Promise<ScheduleRow[]> {
      return db
        .select()
        .from(schedules)
        .where(tenantWhere(scope, schedules))
        .orderBy(asc(schedules.name), asc(schedules.id));
    },

    async findSchedule(
      db: DbOrTx,
      scope: WorkspaceScope,
      id: string,
    ): Promise<ScheduleRow | undefined> {
      const rows = await db
        .select()
        .from(schedules)
        .where(tenantWhere(scope, schedules, eq(schedules.id, id)))
        .limit(1);
      return rows[0];
    },

    async insertSchedule(
      db: DbOrTx,
      scope: WorkspaceScope,
      row: { id: string; name: string; timezone: string; createdBy: string | null },
    ): Promise<ScheduleRow> {
      const [created] = await db.insert(schedules).values(withWorkspace(scope, row)).returning();
      if (created === undefined) throw new Error("schedule insert returned nothing");
      return created;
    },

    async updateSchedule(
      db: DbOrTx,
      scope: WorkspaceScope,
      id: string,
      patch: Partial<Pick<ScheduleRow, "name" | "timezone">>,
    ): Promise<void> {
      await db
        .update(schedules)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(tenantWhere(scope, schedules, eq(schedules.id, id)));
    },

    async deleteSchedule(db: DbOrTx, scope: WorkspaceScope, id: string): Promise<boolean> {
      const rows = await db
        .delete(schedules)
        .where(tenantWhere(scope, schedules, eq(schedules.id, id)))
        .returning({ id: schedules.id });
      return rows.length > 0;
    },

    /* Layers of these schedules, lowest position first. */
    async layersOf(
      db: DbOrTx,
      scope: WorkspaceScope,
      scheduleIds: string[],
    ): Promise<ScheduleLayerRow[]> {
      if (scheduleIds.length === 0) return [];
      return db
        .select()
        .from(scheduleLayers)
        .where(tenantWhere(scope, scheduleLayers, inArray(scheduleLayers.scheduleId, scheduleIds)))
        .orderBy(asc(scheduleLayers.position), asc(scheduleLayers.id));
    },

    async replaceLayers(
      db: DbOrTx,
      scope: WorkspaceScope,
      scheduleId: string,
      layers: NewLayer[],
    ): Promise<void> {
      await db
        .delete(scheduleLayers)
        .where(tenantWhere(scope, scheduleLayers, eq(scheduleLayers.scheduleId, scheduleId)));
      if (layers.length === 0) return;
      await db
        .insert(scheduleLayers)
        .values(
          layers.map((layer, position) => withWorkspace(scope, { ...layer, scheduleId, position })),
        );
    },

    /* Overrides of these schedules that overlap (from, to). */
    async overridesOf(
      db: DbOrTx,
      scope: WorkspaceScope,
      scheduleIds: string[],
      from: Date,
      to: Date,
    ): Promise<ScheduleOverrideRow[]> {
      if (scheduleIds.length === 0) return [];
      return db
        .select()
        .from(scheduleOverrides)
        .where(
          tenantWhere(
            scope,
            scheduleOverrides,
            inArray(scheduleOverrides.scheduleId, scheduleIds),
            gt(scheduleOverrides.endsAt, from),
            lt(scheduleOverrides.startsAt, to),
          ),
        )
        .orderBy(asc(scheduleOverrides.startsAt), asc(scheduleOverrides.id));
    },

    async listEscalationPolicies(
      db: DbOrTx,
      scope: WorkspaceScope,
    ): Promise<EscalationPolicyRow[]> {
      return db
        .select()
        .from(escalationPolicies)
        .where(tenantWhere(scope, escalationPolicies))
        .orderBy(asc(escalationPolicies.name), asc(escalationPolicies.id));
    },

    async findEscalationPolicy(
      db: DbOrTx,
      scope: WorkspaceScope,
      id: string,
    ): Promise<EscalationPolicyRow | undefined> {
      const rows = await db
        .select()
        .from(escalationPolicies)
        .where(tenantWhere(scope, escalationPolicies, eq(escalationPolicies.id, id)))
        .limit(1);
      return rows[0];
    },

    async insertEscalationPolicy(
      db: DbOrTx,
      scope: WorkspaceScope,
      row: Pick<EscalationPolicyRow, "id" | "name" | "repeat" | "steps" | "createdBy">,
    ): Promise<EscalationPolicyRow> {
      const [created] = await db
        .insert(escalationPolicies)
        .values(withWorkspace(scope, row))
        .returning();
      if (created === undefined) throw new Error("escalation policy insert returned nothing");
      return created;
    },

    async updateEscalationPolicy(
      db: DbOrTx,
      scope: WorkspaceScope,
      id: string,
      patch: Partial<Pick<EscalationPolicyRow, "name" | "repeat" | "steps">>,
    ): Promise<EscalationPolicyRow | undefined> {
      const [row] = await db
        .update(escalationPolicies)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(tenantWhere(scope, escalationPolicies, eq(escalationPolicies.id, id)))
        .returning();
      return row;
    },

    async deleteEscalationPolicy(db: DbOrTx, scope: WorkspaceScope, id: string): Promise<boolean> {
      const rows = await db
        .delete(escalationPolicies)
        .where(tenantWhere(scope, escalationPolicies, eq(escalationPolicies.id, id)))
        .returning({ id: escalationPolicies.id });
      return rows.length > 0;
    },

    /* System: every workspace that has a schedule, for the shift sweep. */
    async workspacesWithSchedules(db: DbOrTx): Promise<string[]> {
      const rows = await db.selectDistinct({ workspaceId: schedules.workspaceId }).from(schedules);
      return rows.map((r) => r.workspaceId);
    },

    /* True when this start or end hasn't been announced yet (and now counts as announced). */
    async claimShiftNotice(
      db: DbOrTx,
      scope: WorkspaceScope,
      row: { id: string; scheduleId: string; userId: string; kind: "start" | "end"; at: Date },
    ): Promise<boolean> {
      const rows = await db
        .insert(shiftNotices)
        .values(withWorkspace(scope, row))
        .onConflictDoNothing()
        .returning({ id: shiftNotices.id });
      return rows.length > 0;
    },

    async findFeed(
      db: DbOrTx,
      scope: WorkspaceScope,
      userId: string,
    ): Promise<OncallFeedRow | undefined> {
      const rows = await db
        .select()
        .from(oncallFeeds)
        .where(tenantWhere(scope, oncallFeeds, eq(oncallFeeds.userId, userId)))
        .limit(1);
      return rows[0];
    },

    /* Token URLs carry no workspace; the hash is unique across all of them. */
    async findFeedByHash(db: DbOrTx, tokenHash: string): Promise<OncallFeedRow | undefined> {
      const rows = await db
        .select()
        .from(oncallFeeds)
        .where(eq(oncallFeeds.tokenHash, tokenHash))
        .limit(1);
      return rows[0];
    },

    /* One feed per person and workspace: a new token replaces the old one. */
    async saveFeed(
      db: DbOrTx,
      scope: WorkspaceScope,
      row: { id: string; userId: string; tokenHash: string },
    ): Promise<void> {
      await db
        .insert(oncallFeeds)
        .values(withWorkspace(scope, row))
        .onConflictDoUpdate({
          target: [oncallFeeds.workspaceId, oncallFeeds.userId],
          set: { tokenHash: row.tokenHash, createdAt: sql`now()` },
        });
    },

    async deleteFeed(db: DbOrTx, scope: WorkspaceScope, userId: string): Promise<void> {
      await db
        .delete(oncallFeeds)
        .where(tenantWhere(scope, oncallFeeds, eq(oncallFeeds.userId, userId)));
    },

    async insertOverride(
      db: DbOrTx,
      scope: WorkspaceScope,
      row: {
        id: string;
        scheduleId: string;
        userId: string;
        startsAt: Date;
        endsAt: Date;
        createdBy: string | null;
      },
    ): Promise<ScheduleOverrideRow> {
      const [created] = await db
        .insert(scheduleOverrides)
        .values(withWorkspace(scope, row))
        .returning();
      if (created === undefined) throw new Error("override insert returned nothing");
      return created;
    },

    async deleteOverride(
      db: DbOrTx,
      scope: WorkspaceScope,
      scheduleId: string,
      id: string,
    ): Promise<boolean> {
      const rows = await db
        .delete(scheduleOverrides)
        .where(
          and(
            tenantWhere(scope, scheduleOverrides, eq(scheduleOverrides.id, id)),
            eq(scheduleOverrides.scheduleId, scheduleId),
          ),
        )
        .returning({ id: scheduleOverrides.id });
      return rows.length > 0;
    },
  };
}
