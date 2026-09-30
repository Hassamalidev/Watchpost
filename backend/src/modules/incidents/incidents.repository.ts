/* Queries on incidents, incident_events and incident_comments, owned by the incidents module. */
import { and, asc, desc, eq, lt, ne, sql, type SQL } from "drizzle-orm";
import { assertWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import { tenantWhere, withWorkspace, type DbOrTx } from "../../infra/db/index.js";
import {
  incidentComments,
  incidentEvents,
  incidents,
  type IncidentCommentRow,
  type IncidentEventRow,
  type IncidentRow,
  type IncidentStatus,
} from "./schema/incidents.js";

export type NewIncident = typeof incidents.$inferInsert;
export type NewIncidentEvent = typeof incidentEvents.$inferInsert;

export interface IncidentFilters {
  limit: number;
  cursor?: string | undefined;
  /* "open" means anything not resolved. */
  status?: IncidentStatus | "open" | undefined;
  monitorId?: string | undefined;
  severity?: IncidentRow["severity"] | undefined;
}

export type IncidentRef = { id: string } | { number: number };

export type IncidentsRepository = ReturnType<typeof createIncidentsRepository>;

export function createIncidentsRepository() {
  return {
    /* System queries (detection, heartbeats): no tenant scope, keyed by monitor. */

    async findOpenForMonitor(
      tx: DbOrTx,
      monitorId: string,
      lock = false,
    ): Promise<IncidentRow | undefined> {
      const query = tx
        .select()
        .from(incidents)
        .where(and(eq(incidents.monitorId, monitorId), ne(incidents.status, "resolved")))
        .limit(1);
      const rows = lock ? await query.for("update") : await query;
      return rows[0];
    },

    /* Inserts unless the monitor already has an open incident (the partial unique index decides). */
    async insertForMonitor(tx: DbOrTx, row: NewIncident): Promise<IncidentRow | undefined> {
      const [created] = await tx
        .insert(incidents)
        .values(row)
        .onConflictDoNothing({
          target: incidents.monitorId,
          where: sql`${incidents.status} <> 'resolved' and ${incidents.monitorId} is not null`,
        })
        .returning();
      return created;
    },

    async update(
      tx: DbOrTx,
      id: string,
      patch: Partial<NewIncident>,
    ): Promise<IncidentRow | undefined> {
      const [row] = await tx
        .update(incidents)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(eq(incidents.id, id))
        .returning();
      return row;
    },

    async addEvent(tx: DbOrTx, row: NewIncidentEvent): Promise<void> {
      await tx.insert(incidentEvents).values(row);
    },

    async findById(tx: DbOrTx, id: string): Promise<IncidentRow | undefined> {
      const rows = await tx.select().from(incidents).where(eq(incidents.id, id)).limit(1);
      return rows[0];
    },

    /* Tenant queries (the API). */

    async findScoped(
      tx: DbOrTx,
      scope: WorkspaceScope,
      ref: IncidentRef,
      lock = false,
    ): Promise<IncidentRow | undefined> {
      const query = tx
        .select()
        .from(incidents)
        .where(
          tenantWhere(
            scope,
            incidents,
            "id" in ref ? eq(incidents.id, ref.id) : eq(incidents.number, ref.number),
          ),
        )
        .limit(1);
      const rows = lock ? await query.for("update") : await query;
      return rows[0];
    },

    async list(tx: DbOrTx, scope: WorkspaceScope, filters: IncidentFilters) {
      const status: SQL | undefined =
        filters.status === undefined
          ? undefined
          : filters.status === "open"
            ? ne(incidents.status, "resolved")
            : eq(incidents.status, filters.status);
      return tx
        .select()
        .from(incidents)
        .where(
          tenantWhere(
            scope,
            incidents,
            status,
            filters.cursor ? lt(incidents.id, filters.cursor) : undefined,
            filters.monitorId ? eq(incidents.monitorId, filters.monitorId) : undefined,
            filters.severity ? eq(incidents.severity, filters.severity) : undefined,
          ),
        )
        .orderBy(desc(incidents.id))
        .limit(filters.limit);
    },

    /* Manual incidents; undefined when the monitor already has an open incident. */
    async insertScoped(
      tx: DbOrTx,
      scope: WorkspaceScope,
      row: Omit<NewIncident, "workspaceId">,
    ): Promise<IncidentRow | undefined> {
      const [created] = await tx
        .insert(incidents)
        .values(withWorkspace(scope, row))
        .onConflictDoNothing()
        .returning();
      return created;
    },

    async events(
      tx: DbOrTx,
      scope: WorkspaceScope,
      incidentId: string,
    ): Promise<IncidentEventRow[]> {
      assertWorkspaceScope(scope);
      return tx
        .select()
        .from(incidentEvents)
        .where(
          and(
            eq(incidentEvents.incidentId, incidentId),
            eq(incidentEvents.workspaceId, scope.workspaceId),
          ),
        )
        .orderBy(asc(incidentEvents.at), asc(incidentEvents.id));
    },

    async comments(
      tx: DbOrTx,
      scope: WorkspaceScope,
      incidentId: string,
    ): Promise<IncidentCommentRow[]> {
      assertWorkspaceScope(scope);
      return tx
        .select()
        .from(incidentComments)
        .where(
          and(
            eq(incidentComments.incidentId, incidentId),
            eq(incidentComments.workspaceId, scope.workspaceId),
          ),
        )
        .orderBy(asc(incidentComments.createdAt), asc(incidentComments.id));
    },

    async insertComment(
      tx: DbOrTx,
      scope: WorkspaceScope,
      row: Omit<typeof incidentComments.$inferInsert, "workspaceId">,
    ): Promise<IncidentCommentRow> {
      const [created] = await tx
        .insert(incidentComments)
        .values(withWorkspace(scope, row))
        .returning();
      if (created === undefined) throw new Error("comment insert returned nothing");
      return created;
    },
  };
}
