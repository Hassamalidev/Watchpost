/* Drizzle queries for this module's own tables only (tables go in schema/). */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import { tenantWhere, withWorkspace, type DbOrTx } from "../../infra/db/index.js";
import { maintenanceWindows, type MaintenanceWindowRow } from "./schema/maintenance.js";

export type MaintenanceRepository = ReturnType<typeof createMaintenanceRepository>;

type Editable = Pick<
  MaintenanceWindowRow,
  "name" | "startsAt" | "endsAt" | "rrule" | "timezone" | "scope" | "suppressAlerts" | "showOnPages"
>;

export function createMaintenanceRepository(db: DbOrTx) {
  return {
    async list(scope: WorkspaceScope): Promise<MaintenanceWindowRow[]> {
      return db
        .select()
        .from(maintenanceWindows)
        .where(tenantWhere(scope, maintenanceWindows))
        .orderBy(asc(maintenanceWindows.startsAt), asc(maintenanceWindows.id));
    },

    async find(scope: WorkspaceScope, id: string): Promise<MaintenanceWindowRow | undefined> {
      const rows = await db
        .select()
        .from(maintenanceWindows)
        .where(tenantWhere(scope, maintenanceWindows, eq(maintenanceWindows.id, id)))
        .limit(1);
      return rows[0];
    },

    async insert(
      scope: WorkspaceScope,
      row: Editable & { id: string; createdBy: string | null },
    ): Promise<MaintenanceWindowRow> {
      const [created] = await db
        .insert(maintenanceWindows)
        .values(withWorkspace(scope, row))
        .returning();
      if (created === undefined) throw new Error("maintenance window insert returned nothing");
      return created;
    },

    /* An edit can bring a finished window back, so the sweep looks at it again from scratch. */
    async update(
      scope: WorkspaceScope,
      id: string,
      patch: Partial<Editable>,
    ): Promise<MaintenanceWindowRow | undefined> {
      const [row] = await db
        .update(maintenanceWindows)
        .set({ ...patch, active: false, finishedAt: null, updatedAt: sql`now()` })
        .where(tenantWhere(scope, maintenanceWindows, eq(maintenanceWindows.id, id)))
        .returning();
      return row;
    },

    async delete(scope: WorkspaceScope, id: string): Promise<boolean> {
      const rows = await db
        .delete(maintenanceWindows)
        .where(tenantWhere(scope, maintenanceWindows, eq(maintenanceWindows.id, id)))
        .returning({ id: maintenanceWindows.id });
      return rows.length > 0;
    },

    /* System: windows of one workspace that can still be in effect and silence alerts. */
    async suppressing(workspaceId: string): Promise<MaintenanceWindowRow[]> {
      return db
        .select()
        .from(maintenanceWindows)
        .where(
          and(
            eq(maintenanceWindows.workspaceId, workspaceId),
            eq(maintenanceWindows.suppressAlerts, true),
            isNull(maintenanceWindows.finishedAt),
          ),
        );
    },

    /* System (boundary sweep): every window that isn't finished, across workspaces. */
    async unfinished(): Promise<MaintenanceWindowRow[]> {
      return db.select().from(maintenanceWindows).where(isNull(maintenanceWindows.finishedAt));
    },

    /* Records what the sweep saw. True if this call changed it (another sweep didn't get there first). */
    async setState(
      id: string,
      state: { active: boolean; finishedAt: Date | null },
    ): Promise<boolean> {
      const rows = await db
        .update(maintenanceWindows)
        .set({ active: state.active, finishedAt: state.finishedAt })
        .where(
          and(
            eq(maintenanceWindows.id, id),
            sql`(${maintenanceWindows.active} is distinct from ${state.active}
              or (${maintenanceWindows.finishedAt} is null) is distinct from ${state.finishedAt === null})`,
          ),
        )
        .returning({ id: maintenanceWindows.id });
      return rows.length > 0;
    },
  };
}
