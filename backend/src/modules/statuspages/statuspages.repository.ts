/* Drizzle queries for this module's own tables only (tables go in schema/). */
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import { tenantWhere, withWorkspace, type DbOrTx } from "../../infra/db/index.js";
import {
  statusComponents,
  statusIncidents,
  statusPages,
  statusUpdates,
  type StatusComponentRow,
  type StatusIncidentRow,
  type StatusPageRow,
  type StatusUpdateRow,
} from "./schema/statuspages.js";

export type StatuspagesRepository = ReturnType<typeof createStatuspagesRepository>;

type PageEditable = Pick<StatusPageRow, "name" | "slug" | "branding" | "settings" | "published">;
type ComponentEditable = Pick<
  StatusComponentRow,
  "name" | "description" | "monitorId" | "manualStatus" | "groupName" | "showUptime" | "position"
>;

export function createStatuspagesRepository(db: DbOrTx) {
  return {
    /* Pages */

    async listPages(scope: WorkspaceScope): Promise<StatusPageRow[]> {
      return db
        .select()
        .from(statusPages)
        .where(tenantWhere(scope, statusPages))
        .orderBy(asc(statusPages.createdAt), asc(statusPages.id));
    },

    async countPages(tx: DbOrTx, scope: WorkspaceScope): Promise<number> {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(statusPages)
        .where(tenantWhere(scope, statusPages));
      return row?.n ?? 0;
    },

    async findPage(tx: DbOrTx, scope: WorkspaceScope, id: string) {
      const rows = await tx
        .select()
        .from(statusPages)
        .where(tenantWhere(scope, statusPages, eq(statusPages.id, id)))
        .limit(1);
      return rows[0];
    },

    /* Public: a page by its subdomain, or by a verified custom domain. No tenant scope. */
    async findPublished(ref: { slug: string } | { host: string }) {
      const rows = await db
        .select()
        .from(statusPages)
        .where(
          and(
            eq(statusPages.published, true),
            "slug" in ref
              ? eq(statusPages.slug, ref.slug)
              : and(
                  eq(statusPages.customDomain, ref.host),
                  sql`${statusPages.domainVerifiedAt} is not null`,
                ),
          ),
        )
        .limit(1);
      return rows[0];
    },

    /* System (Caddy's on-demand TLS): is this host a verified domain of a published page? */
    async servesHost(host: string): Promise<boolean> {
      const rows = await db
        .select({ id: statusPages.id })
        .from(statusPages)
        .where(
          and(
            eq(statusPages.customDomain, host),
            eq(statusPages.published, true),
            sql`${statusPages.domainVerifiedAt} is not null`,
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    /*
     * System: pages whose domain is due for a DNS check. A verified domain is looked at daily; one
     * still waiting is looked at every few minutes while it is new, then daily.
     */
    async domainsDue(now: Date, limit: number): Promise<StatusPageRow[]> {
      const day = new Date(now.getTime() - 86_400_000);
      const minutes = new Date(now.getTime() - 5 * 60_000);
      const fresh = new Date(now.getTime() - 3 * 86_400_000);
      return db
        .select()
        .from(statusPages)
        .where(
          and(
            sql`${statusPages.customDomain} is not null`,
            or(
              isNull(statusPages.domainCheckedAt),
              lt(statusPages.domainCheckedAt, day),
              and(
                isNull(statusPages.domainVerifiedAt),
                gte(statusPages.updatedAt, fresh),
                lt(statusPages.domainCheckedAt, minutes),
              ),
            ),
          ),
        )
        .orderBy(asc(statusPages.domainCheckedAt))
        .limit(limit);
    },

    /* System: records the outcome of a DNS check without touching `updated_at`. */
    async recordDomainCheck(
      id: string,
      patch: Pick<
        StatusPageRow,
        "domainVerifiedAt" | "domainCheckedAt" | "domainError" | "domainFailingSince"
      >,
    ): Promise<StatusPageRow | undefined> {
      const [row] = await db
        .update(statusPages)
        .set(patch)
        .where(eq(statusPages.id, id))
        .returning();
      return row;
    },

    /* System: pages by ID, whatever the workspace (event handlers reload what an event names). */
    async pagesByIds(ids: string[]): Promise<StatusPageRow[]> {
      if (ids.length === 0) return [];
      return db.select().from(statusPages).where(inArray(statusPages.id, ids));
    },

    async insertPage(
      tx: DbOrTx,
      scope: WorkspaceScope,
      row: PageEditable & { id: string },
    ): Promise<StatusPageRow | undefined> {
      const [created] = await tx
        .insert(statusPages)
        .values(withWorkspace(scope, row))
        .onConflictDoNothing({ target: statusPages.slug })
        .returning();
      return created;
    },

    async updatePage(
      tx: DbOrTx,
      scope: WorkspaceScope,
      id: string,
      patch: Partial<
        PageEditable &
          Pick<
            StatusPageRow,
            | "customDomain"
            | "domainVerifiedAt"
            | "domainCheckedAt"
            | "domainError"
            | "domainFailingSince"
          >
      >,
    ): Promise<StatusPageRow | undefined> {
      const [row] = await tx
        .update(statusPages)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(tenantWhere(scope, statusPages, eq(statusPages.id, id)))
        .returning();
      return row;
    },

    async deletePage(scope: WorkspaceScope, id: string): Promise<boolean> {
      const rows = await db
        .delete(statusPages)
        .where(tenantWhere(scope, statusPages, eq(statusPages.id, id)))
        .returning({ id: statusPages.id });
      return rows.length > 0;
    },

    /* Components */

    async componentsOf(tx: DbOrTx, pageIds: string[]): Promise<StatusComponentRow[]> {
      if (pageIds.length === 0) return [];
      return tx
        .select()
        .from(statusComponents)
        .where(inArray(statusComponents.pageId, pageIds))
        .orderBy(asc(statusComponents.position), asc(statusComponents.id));
    },

    /* System: the components that show these monitors, on any page. */
    async componentsForMonitors(monitorIds: string[]): Promise<StatusComponentRow[]> {
      if (monitorIds.length === 0) return [];
      return db
        .select()
        .from(statusComponents)
        .where(inArray(statusComponents.monitorId, monitorIds));
    },

    async insertComponents(
      tx: DbOrTx,
      scope: WorkspaceScope,
      pageId: string,
      rows: Array<ComponentEditable & { id: string }>,
    ): Promise<void> {
      if (rows.length === 0) return;
      await tx
        .insert(statusComponents)
        .values(rows.map((row) => withWorkspace(scope, { ...row, pageId })));
    },

    async updateComponent(
      tx: DbOrTx,
      scope: WorkspaceScope,
      id: string,
      patch: ComponentEditable,
    ): Promise<void> {
      await tx
        .update(statusComponents)
        .set(patch)
        .where(tenantWhere(scope, statusComponents, eq(statusComponents.id, id)));
    },

    async deleteComponents(tx: DbOrTx, scope: WorkspaceScope, ids: string[]): Promise<void> {
      if (ids.length === 0) return;
      await tx
        .delete(statusComponents)
        .where(tenantWhere(scope, statusComponents, inArray(statusComponents.id, ids)));
    },

    /* System: a deleted monitor leaves its components behind, set by hand from now on. */
    async unlinkMonitor(monitorId: string): Promise<StatusComponentRow[]> {
      return db
        .update(statusComponents)
        .set({ monitorId: null, manualStatus: "operational" })
        .where(eq(statusComponents.monitorId, monitorId))
        .returning();
    },

    /* Incidents and updates */

    /* Open incidents and those that started or ended since `since`, newest first. */
    async incidentsOf(
      tx: DbOrTx,
      pageId: string,
      options: { since: Date; publishedOnly: boolean; limit: number },
    ): Promise<StatusIncidentRow[]> {
      return tx
        .select()
        .from(statusIncidents)
        .where(
          and(
            eq(statusIncidents.pageId, pageId),
            options.publishedOnly ? eq(statusIncidents.published, true) : undefined,
            or(
              isNull(statusIncidents.resolvedAt),
              gte(statusIncidents.resolvedAt, options.since),
              gte(statusIncidents.startedAt, options.since),
            ),
          ),
        )
        .orderBy(desc(statusIncidents.startedAt), desc(statusIncidents.id))
        .limit(options.limit);
    },

    async findIncident(tx: DbOrTx, scope: WorkspaceScope, id: string, lock = false) {
      const query = tx
        .select()
        .from(statusIncidents)
        .where(tenantWhere(scope, statusIncidents, eq(statusIncidents.id, id)))
        .limit(1);
      const rows = lock ? await query.for("update") : await query;
      return rows[0];
    },

    async insertIncident(
      tx: DbOrTx,
      scope: WorkspaceScope,
      row: Pick<
        StatusIncidentRow,
        | "id"
        | "pageId"
        | "title"
        | "status"
        | "impact"
        | "componentIds"
        | "published"
        | "autoMonitorId"
        | "startedAt"
        | "resolvedAt"
        | "createdBy"
      >,
    ): Promise<StatusIncidentRow | undefined> {
      const [created] = await tx
        .insert(statusIncidents)
        .values(withWorkspace(scope, row))
        .onConflictDoNothing()
        .returning();
      return created;
    },

    async updateIncident(
      tx: DbOrTx,
      scope: WorkspaceScope,
      id: string,
      patch: Partial<
        Pick<
          StatusIncidentRow,
          "title" | "status" | "impact" | "componentIds" | "published" | "resolvedAt"
        >
      >,
    ): Promise<StatusIncidentRow | undefined> {
      const [row] = await tx
        .update(statusIncidents)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(tenantWhere(scope, statusIncidents, eq(statusIncidents.id, id)))
        .returning();
      return row;
    },

    async deleteIncident(
      scope: WorkspaceScope,
      id: string,
    ): Promise<StatusIncidentRow | undefined> {
      const [row] = await db
        .delete(statusIncidents)
        .where(tenantWhere(scope, statusIncidents, eq(statusIncidents.id, id)))
        .returning();
      return row;
    },

    async insertUpdate(
      tx: DbOrTx,
      scope: WorkspaceScope,
      row: Pick<
        StatusUpdateRow,
        "id" | "statusIncidentId" | "status" | "body" | "aiDrafted" | "createdBy" | "createdAt"
      >,
    ): Promise<StatusUpdateRow> {
      const [created] = await tx
        .insert(statusUpdates)
        .values(withWorkspace(scope, row))
        .returning();
      if (created === undefined) throw new Error("status update insert returned nothing");
      return created;
    },

    async updatesOf(tx: DbOrTx, incidentIds: string[]): Promise<StatusUpdateRow[]> {
      if (incidentIds.length === 0) return [];
      return tx
        .select()
        .from(statusUpdates)
        .where(inArray(statusUpdates.statusIncidentId, incidentIds))
        .orderBy(desc(statusUpdates.createdAt), desc(statusUpdates.id));
    },
  };
}
