/* Queries on incidents, incident_events and incident_comments, owned by the incidents module. */
import { and, asc, desc, eq, gt, inArray, lt, ne, notInArray, sql, type SQL } from "drizzle-orm";
import { assertWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import { tenantWhere, withWorkspace, type DbOrTx } from "../../infra/db/index.js";
import {
  incidentComments,
  incidentEvents,
  incidents,
  postmortems,
  type PostmortemRow,
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
    /* Postmortems */

    async findPostmortem(tx: DbOrTx, incidentId: string): Promise<PostmortemRow | undefined> {
      const rows = await tx
        .select()
        .from(postmortems)
        .where(eq(postmortems.incidentId, incidentId))
        .limit(1);
      return rows[0];
    },

    /* Creates or replaces the incident's postmortem. A null generation keeps the stored one. */
    async savePostmortem(
      tx: DbOrTx,
      row: Pick<PostmortemRow, "incidentId" | "workspaceId" | "markdown" | "updatedBy"> & {
        aiGenerationId: string | null;
      },
      at: Date,
    ): Promise<PostmortemRow> {
      const [saved] = await tx
        .insert(postmortems)
        .values({ ...row, createdAt: at, updatedAt: at })
        .onConflictDoUpdate({
          target: postmortems.incidentId,
          set: {
            markdown: row.markdown,
            updatedBy: row.updatedBy,
            updatedAt: at,
            ...(row.aiGenerationId === null ? {} : { aiGenerationId: row.aiGenerationId }),
          },
        })
        .returning();
      if (saved === undefined) throw new Error("postmortem upsert returned nothing");
      return saved;
    },

    /* System queries (detection, heartbeats): no tenant scope, keyed by monitor. */

    async findOpenForMonitor(
      tx: DbOrTx,
      monitorId: string,
      lock = false,
    ): Promise<IncidentRow | undefined> {
      const query = tx
        .select()
        .from(incidents)
        .where(
          and(
            eq(incidents.monitorId, monitorId),
            ne(incidents.status, "resolved"),
            ne(incidents.source, "expiry"),
          ),
        )
        .limit(1);
      const rows = lock ? await query.for("update") : await query;
      return rows[0];
    },

    async findOpenByDedupKey(
      tx: DbOrTx,
      workspaceId: string,
      dedupKey: string,
    ): Promise<IncidentRow | undefined> {
      const rows = await tx
        .select()
        .from(incidents)
        .where(
          and(
            eq(incidents.workspaceId, workspaceId),
            eq(incidents.dedupKey, dedupKey),
            ne(incidents.status, "resolved"),
          ),
        )
        .limit(1)
        .for("update");
      return rows[0];
    },

    /* Inserts unless an open incident has the same dedup key; undefined on conflict. */
    async insertDeduplicated(tx: DbOrTx, row: NewIncident): Promise<IncidentRow | undefined> {
      const [created] = await tx
        .insert(incidents)
        .values(row)
        .onConflictDoNothing({
          target: [incidents.workspaceId, incidents.dedupKey],
          where: sql`${incidents.status} <> 'resolved' and ${incidents.dedupKey} is not null`,
        })
        .returning();
      return created;
    },

    /* Open incidents that were opened quietly because this one explains them (§9.6). */
    async openSuppressedBy(tx: DbOrTx, incidentId: string): Promise<IncidentRow[]> {
      return tx
        .select()
        .from(incidents)
        .where(
          and(eq(incidents.suppressedByIncidentId, incidentId), ne(incidents.status, "resolved")),
        )
        .orderBy(asc(incidents.startedAt), asc(incidents.id))
        .for("update");
    },

    /* Inserts unless the monitor already has an open incident (the partial unique index decides). */
    async insertForMonitor(tx: DbOrTx, row: NewIncident): Promise<IncidentRow | undefined> {
      const [created] = await tx
        .insert(incidents)
        .values(row)
        .onConflictDoNothing({
          target: incidents.monitorId,
          where: sql`${incidents.status} <> 'resolved' and ${incidents.monitorId} is not null and ${incidents.source} <> 'expiry'`,
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

    async openIds(tx: DbOrTx, options: { afterId?: string; limit: number }): Promise<string[]> {
      const rows = await tx
        .select({ id: incidents.id })
        .from(incidents)
        .where(
          and(
            ne(incidents.status, "resolved"),
            options.afterId ? gt(incidents.id, options.afterId) : undefined,
          ),
        )
        .orderBy(asc(incidents.id))
        .limit(options.limit);
      return rows.map((r) => r.id);
    },

    /*
     * Real incidents (not expiry warnings or drills) started in [from, to): opened, resolved, false
     * alarms, and mean times to acknowledge and to resolve.
     */
    /*
     * Per-monitor noise since `from` (check-driven incidents only): false alarms, flapping, and
     * incidents that resolved on their own within five minutes.
     */
    async noiseByMonitor(tx: DbOrTx, scope: WorkspaceScope, from: Date, monitorId?: string) {
      return tx
        .select({
          monitorId: sql<string>`${incidents.monitorId}`,
          incidents: sql<number>`count(*)::int`,
          falseAlarms: sql<number>`(count(*) filter (where ${incidents.falseAlarm}))::int`,
          flapping: sql<number>`(count(*) filter (where ${incidents.flapping}))::int`,
          shortLived: sql<number>`(count(*) filter (where ${incidents.autoResolved} and ${incidents.resolvedAt} - ${incidents.startedAt} < interval '5 minutes'))::int`,
        })
        .from(incidents)
        .where(
          tenantWhere(
            scope,
            incidents,
            sql`${incidents.source} in ('monitor', 'heartbeat')`,
            sql`${incidents.monitorId} is not null`,
            sql`${incidents.startedAt} >= ${from.toISOString()}::timestamptz`,
            monitorId === undefined ? undefined : eq(incidents.monitorId, monitorId),
          ),
        )
        .groupBy(incidents.monitorId);
    },

    /* Incidents that started in [from, to), newest first (drills and expiry warnings left out). */
    async startedBetween(
      tx: DbOrTx,
      workspaceId: string,
      from: Date,
      to: Date,
      limit: number,
    ): Promise<IncidentRow[]> {
      return tx
        .select()
        .from(incidents)
        .where(
          and(
            eq(incidents.workspaceId, workspaceId),
            notInArray(incidents.source, ["expiry", "drill"]),
            sql`${incidents.startedAt} >= ${from.toISOString()}::timestamptz`,
            sql`${incidents.startedAt} < ${to.toISOString()}::timestamptz`,
          ),
        )
        .orderBy(desc(incidents.startedAt))
        .limit(limit);
    },

    /* Incidents nobody has resolved yet, oldest first. */
    async stillOpen(tx: DbOrTx, workspaceId: string, limit: number): Promise<IncidentRow[]> {
      return tx
        .select()
        .from(incidents)
        .where(
          and(
            eq(incidents.workspaceId, workspaceId),
            ne(incidents.status, "resolved"),
            notInArray(incidents.source, ["expiry", "drill"]),
          ),
        )
        .orderBy(asc(incidents.startedAt))
        .limit(limit);
    },

    /*
     * Per monitor, incidents started in [from, to): how many, and the sums behind the mean times to
     * acknowledge and to resolve (sums and counts, so a caller can combine monitors correctly).
     */
    async statsByMonitor(
      tx: DbOrTx,
      workspaceId: string,
      monitorIds: string[],
      from: Date,
      to: Date,
    ) {
      if (monitorIds.length === 0) return [];
      const rows = await tx
        .select({
          monitorId: incidents.monitorId,
          opened: sql<number>`count(*)::int`,
          acked: sql<number>`(count(*) filter (where ${incidents.ackedAt} is not null))::int`,
          resolved: sql<number>`(count(*) filter (where ${incidents.status} = 'resolved'))::int`,
          ackSeconds: sql<
            string | null
          >`sum(extract(epoch from ${incidents.ackedAt} - ${incidents.startedAt})) filter (where ${incidents.ackedAt} is not null)`,
          resolveSeconds: sql<
            string | null
          >`sum(extract(epoch from ${incidents.resolvedAt} - ${incidents.startedAt})) filter (where ${incidents.status} = 'resolved')`,
        })
        .from(incidents)
        .where(
          and(
            eq(incidents.workspaceId, workspaceId),
            inArray(incidents.monitorId, monitorIds),
            notInArray(incidents.source, ["expiry", "drill"]),
            sql`${incidents.startedAt} >= ${from.toISOString()}::timestamptz`,
            sql`${incidents.startedAt} < ${to.toISOString()}::timestamptz`,
          ),
        )
        .groupBy(incidents.monitorId);
      return rows.flatMap((row) =>
        row.monitorId === null
          ? []
          : [
              {
                monitorId: row.monitorId,
                opened: row.opened,
                acked: row.acked,
                resolved: row.resolved,
                ackSeconds: Number(row.ackSeconds ?? 0),
                resolveSeconds: Number(row.resolveSeconds ?? 0),
              },
            ],
      );
    },

    async stats(tx: DbOrTx, workspaceId: string, from: Date, to: Date) {
      const [row] = await tx
        .select({
          opened: sql<number>`count(*)::int`,
          resolved: sql<number>`(count(*) filter (where ${incidents.status} = 'resolved'))::int`,
          falseAlarms: sql<number>`(count(*) filter (where ${incidents.falseAlarm}))::int`,
          mttrSeconds: sql<
            number | null
          >`avg(extract(epoch from ${incidents.resolvedAt} - ${incidents.startedAt})) filter (where ${incidents.status} = 'resolved')`,
          mttaSeconds: sql<
            number | null
          >`avg(extract(epoch from ${incidents.ackedAt} - ${incidents.startedAt})) filter (where ${incidents.ackedAt} is not null)`,
        })
        .from(incidents)
        .where(
          and(
            eq(incidents.workspaceId, workspaceId),
            notInArray(incidents.source, ["expiry", "drill"]),
            sql`${incidents.startedAt} >= ${from.toISOString()}::timestamptz`,
            sql`${incidents.startedAt} < ${to.toISOString()}::timestamptz`,
          ),
        );
      const num = (v: number | null | undefined) =>
        v === null || v === undefined ? null : Number(v);
      return {
        opened: row?.opened ?? 0,
        resolved: row?.resolved ?? 0,
        falseAlarms: row?.falseAlarms ?? 0,
        mttrSeconds: num(row?.mttrSeconds),
        mttaSeconds: num(row?.mttaSeconds),
      };
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
