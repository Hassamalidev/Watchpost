/* Drizzle queries for this module's own tables only (tables go in schema/). */
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import { tenantWhere, withWorkspace, type DbOrTx } from "../../infra/db/index.js";
import {
  statusComponents,
  statusIncidents,
  statusNotifications,
  statusPages,
  statusSubscribers,
  statusUpdates,
  type StatusComponentRow,
  type StatusIncidentRow,
  type StatusPageRow,
  type StatusSubscriberRow,
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
            | "visibility"
            | "passwordHash"
            | "allowedIps"
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

    async redateUpdate(tx: DbOrTx, id: string, at: Date): Promise<void> {
      await tx.update(statusUpdates).set({ createdAt: at }).where(eq(statusUpdates.id, id));
    },

    /* System: one update with its incident, for the fan-out to subscribers. */
    async findUpdate(updateId: string) {
      const rows = await db
        .select({ update: statusUpdates, incident: statusIncidents })
        .from(statusUpdates)
        .innerJoin(statusIncidents, eq(statusIncidents.id, statusUpdates.statusIncidentId))
        .where(eq(statusUpdates.id, updateId))
        .limit(1);
      return rows[0];
    },

    /* Automatic incidents (§6.6) */

    /* System: published pages that open incidents by themselves. */
    async pagesWithAutoIncidents(limit: number): Promise<StatusPageRow[]> {
      return db
        .select()
        .from(statusPages)
        .where(
          and(
            eq(statusPages.published, true),
            sql`${statusPages.settings}->'autoIncidents'->>'enabled' = 'true'`,
          ),
        )
        .orderBy(asc(statusPages.id))
        .limit(limit);
    },

    /* System: the page's automatic incidents that are still open. */
    async openAutoIncidents(tx: DbOrTx, pageIds: string[]): Promise<StatusIncidentRow[]> {
      if (pageIds.length === 0) return [];
      return tx
        .select()
        .from(statusIncidents)
        .where(
          and(
            inArray(statusIncidents.pageId, pageIds),
            isNull(statusIncidents.resolvedAt),
            sql`${statusIncidents.autoMonitorId} is not null`,
          ),
        );
    },

    /* Subscribers */

    async findSubscriber(tx: DbOrTx, pageId: string, email: string) {
      const rows = await tx
        .select()
        .from(statusSubscribers)
        .where(and(eq(statusSubscribers.pageId, pageId), eq(statusSubscribers.email, email)))
        .limit(1)
        .for("update");
      return rows[0];
    },

    async insertSubscriber(
      tx: DbOrTx,
      row: typeof statusSubscribers.$inferInsert,
    ): Promise<StatusSubscriberRow | undefined> {
      const [created] = await tx
        .insert(statusSubscribers)
        .values(row)
        .onConflictDoNothing({ target: [statusSubscribers.pageId, statusSubscribers.email] })
        .returning();
      return created;
    },

    async updateSubscriber(
      tx: DbOrTx,
      id: string,
      patch: Partial<
        Pick<StatusSubscriberRow, "confirmedAt" | "confirmTokenHash" | "confirmSentAt">
      >,
    ): Promise<StatusSubscriberRow | undefined> {
      const [row] = await tx
        .update(statusSubscribers)
        .set(patch)
        .where(eq(statusSubscribers.id, id))
        .returning();
      return row;
    },

    async subscriberByConfirmHash(tx: DbOrTx, hash: string) {
      const rows = await tx
        .select()
        .from(statusSubscribers)
        .where(eq(statusSubscribers.confirmTokenHash, hash))
        .limit(1)
        .for("update");
      return rows[0];
    },

    /* The link in every email: removes the subscriber, whoever asks. */
    async deleteSubscriberByToken(token: string): Promise<StatusSubscriberRow | undefined> {
      const [row] = await db
        .delete(statusSubscribers)
        .where(eq(statusSubscribers.unsubToken, token))
        .returning();
      return row;
    },

    async deleteSubscriber(scope: WorkspaceScope, pageId: string, id: string): Promise<boolean> {
      const rows = await db
        .delete(statusSubscribers)
        .where(
          tenantWhere(
            scope,
            statusSubscribers,
            and(eq(statusSubscribers.id, id), eq(statusSubscribers.pageId, pageId)),
          ),
        )
        .returning({ id: statusSubscribers.id });
      return rows.length > 0;
    },

    async countSubscribers(
      tx: DbOrTx,
      pageId: string,
    ): Promise<{ confirmed: number; pending: number }> {
      const [row] = await tx
        .select({
          confirmed: sql<number>`count(*) filter (where ${statusSubscribers.confirmedAt} is not null)::int`,
          pending: sql<number>`count(*) filter (where ${statusSubscribers.confirmedAt} is null)::int`,
        })
        .from(statusSubscribers)
        .where(eq(statusSubscribers.pageId, pageId));
      return { confirmed: row?.confirmed ?? 0, pending: row?.pending ?? 0 };
    },

    async listSubscribers(scope: WorkspaceScope, pageId: string, limit: number) {
      return db
        .select()
        .from(statusSubscribers)
        .where(tenantWhere(scope, statusSubscribers, eq(statusSubscribers.pageId, pageId)))
        .orderBy(desc(statusSubscribers.createdAt), desc(statusSubscribers.id))
        .limit(limit);
    },

    /*
     * Subscribers of a page who had confirmed by `asOf`, after `afterId`, in ID order (the fan-out
     * pages through). Someone who subscribes later is not sent older updates by a late retry.
     */
    async confirmedSubscribers(
      tx: DbOrTx,
      pageId: string,
      asOf: Date,
      afterId: string | undefined,
      limit: number,
    ): Promise<StatusSubscriberRow[]> {
      return tx
        .select()
        .from(statusSubscribers)
        .where(
          and(
            eq(statusSubscribers.pageId, pageId),
            lte(statusSubscribers.confirmedAt, asOf),
            afterId === undefined ? undefined : gt(statusSubscribers.id, afterId),
          ),
        )
        .orderBy(asc(statusSubscribers.id))
        .limit(limit);
    },

    /* Marks these subscribers as told about the update; answers who was not told before. */
    async claimNotifications(
      tx: DbOrTx,
      workspaceId: string,
      updateId: string,
      subscriberIds: string[],
    ): Promise<string[]> {
      if (subscriberIds.length === 0) return [];
      const rows = await tx
        .insert(statusNotifications)
        .values(subscriberIds.map((subscriberId) => ({ subscriberId, updateId, workspaceId })))
        .onConflictDoNothing()
        .returning({ subscriberId: statusNotifications.subscriberId });
      return rows.map((r) => r.subscriberId);
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
