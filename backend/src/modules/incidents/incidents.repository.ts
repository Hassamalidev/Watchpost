/* Queries on incidents and incident_events, owned by the incidents module. */
import { and, eq, ne, sql } from "drizzle-orm";
import type { DbOrTx } from "../../infra/db/index.js";
import { incidentEvents, incidents, type IncidentRow } from "./schema/incidents.js";

export type NewIncident = typeof incidents.$inferInsert;
export type NewIncidentEvent = typeof incidentEvents.$inferInsert;

export type IncidentsRepository = ReturnType<typeof createIncidentsRepository>;

export function createIncidentsRepository() {
  return {
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
  };
}
