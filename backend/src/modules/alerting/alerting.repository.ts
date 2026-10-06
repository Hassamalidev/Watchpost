/* Queries on alert_policies, notification_deliveries and alert_fallback_notices (alerting module). */
import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import { tenantWhere, withWorkspace, type DbOrTx } from "../../infra/db/index.js";
import {
  alertFallbackNotices,
  alertPolicies,
  notificationDeliveries,
  type AlertPolicyRow,
  type DeliveryRow,
  type DeliveryStatus,
} from "./schema/alerting.js";

export type AlertingRepository = ReturnType<typeof createAlertingRepository>;
export type NewDelivery = typeof notificationDeliveries.$inferInsert;

export function createAlertingRepository() {
  return {
    /* Alert policies */

    async listPolicies(tx: DbOrTx, scope: WorkspaceScope): Promise<AlertPolicyRow[]> {
      return tx
        .select()
        .from(alertPolicies)
        .where(tenantWhere(scope, alertPolicies))
        .orderBy(sql`${alertPolicies.isDefault} desc`, asc(alertPolicies.name));
    },

    async findPolicy(
      tx: DbOrTx,
      scope: WorkspaceScope,
      id: string,
    ): Promise<AlertPolicyRow | undefined> {
      const rows = await tx
        .select()
        .from(alertPolicies)
        .where(tenantWhere(scope, alertPolicies, eq(alertPolicies.id, id)))
        .limit(1);
      return rows[0];
    },

    /* `lock` takes the row FOR UPDATE, for read-modify-write changes to its channel list. */
    async findDefaultPolicy(
      tx: DbOrTx,
      scope: WorkspaceScope,
      lock = false,
    ): Promise<AlertPolicyRow | undefined> {
      const query = tx
        .select()
        .from(alertPolicies)
        .where(tenantWhere(scope, alertPolicies, eq(alertPolicies.isDefault, true)))
        .limit(1);
      const rows = lock ? await query.for("update") : await query;
      return rows[0];
    },

    /* Returns the new row, or undefined if the workspace already has a default policy. */
    async insertPolicy(
      tx: DbOrTx,
      scope: WorkspaceScope,
      row: Omit<typeof alertPolicies.$inferInsert, "workspaceId">,
    ): Promise<AlertPolicyRow | undefined> {
      const [created] = await tx
        .insert(alertPolicies)
        .values(withWorkspace(scope, row))
        .onConflictDoNothing()
        .returning();
      return created;
    },

    async updatePolicy(
      tx: DbOrTx,
      scope: WorkspaceScope,
      id: string,
      patch: Partial<Pick<AlertPolicyRow, "name" | "rules">>,
    ): Promise<AlertPolicyRow | undefined> {
      const [row] = await tx
        .update(alertPolicies)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(tenantWhere(scope, alertPolicies, eq(alertPolicies.id, id)))
        .returning();
      return row;
    },

    async deletePolicy(tx: DbOrTx, scope: WorkspaceScope, id: string): Promise<boolean> {
      const rows = await tx
        .delete(alertPolicies)
        .where(
          tenantWhere(
            scope,
            alertPolicies,
            eq(alertPolicies.id, id),
            eq(alertPolicies.isDefault, false),
          ),
        )
        .returning({ id: alertPolicies.id });
      return rows.length > 0;
    },

    /* Deliveries */

    /* Inserts planned deliveries; rows planned before (same event and destination) are skipped. */
    async insertDeliveries(tx: DbOrTx, rows: NewDelivery[]): Promise<DeliveryRow[]> {
      if (rows.length === 0) return [];
      return tx
        .insert(notificationDeliveries)
        .values(rows)
        .onConflictDoNothing({
          target: [notificationDeliveries.eventKey, notificationDeliveries.destinationKey],
        })
        .returning();
    },

    /* Takes a delivery for one send attempt; undefined if it is sent, failed or being sent. */
    async claim(tx: DbOrTx, id: string): Promise<DeliveryRow | undefined> {
      const [row] = await tx
        .update(notificationDeliveries)
        .set({
          status: "sending",
          attempts: sql`${notificationDeliveries.attempts} + 1`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(notificationDeliveries.id, id),
            inArray(notificationDeliveries.status, ["pending", "retrying"]),
          ),
        )
        .returning();
      return row;
    },

    async finish(
      tx: DbOrTx,
      id: string,
      patch: {
        status: DeliveryStatus;
        providerRef?: string | null;
        error?: string | null;
        sentAt?: Date | null;
      },
    ): Promise<void> {
      await tx
        .update(notificationDeliveries)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(eq(notificationDeliveries.id, id));
    },

    async findDelivery(tx: DbOrTx, id: string): Promise<DeliveryRow | undefined> {
      const rows = await tx
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.id, id))
        .limit(1);
      return rows[0];
    },

    async deliveriesForIncidentScoped(
      tx: DbOrTx,
      scope: WorkspaceScope,
      incidentId: string,
    ): Promise<DeliveryRow[]> {
      return tx
        .select()
        .from(notificationDeliveries)
        .where(
          and(
            eq(notificationDeliveries.workspaceId, scope.workspaceId),
            eq(notificationDeliveries.incidentId, incidentId),
          ),
        )
        .orderBy(asc(notificationDeliveries.createdAt), asc(notificationDeliveries.id));
    },

    async deliveriesForIncident(tx: DbOrTx, incidentId: string): Promise<DeliveryRow[]> {
      return tx
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.incidentId, incidentId))
        .orderBy(asc(notificationDeliveries.createdAt), asc(notificationDeliveries.id));
    },

    /*
     * Deliveries whose job may be lost: waiting (pending/retrying) past their backoff for longer than
     * `olderThan`, or stuck mid-send. Stuck sends are moved back to retrying.
     */
    async unfinished(tx: DbOrTx, olderThan: Date, limit: number): Promise<DeliveryRow[]> {
      await tx
        .update(notificationDeliveries)
        /* updated_at stays, so the select below picks these up in the same pass. */
        .set({ status: "retrying" })
        .where(
          and(
            eq(notificationDeliveries.status, "sending"),
            lt(notificationDeliveries.updatedAt, olderThan),
          ),
        );
      return tx
        .select()
        .from(notificationDeliveries)
        .where(
          and(
            or(
              eq(notificationDeliveries.status, "pending"),
              eq(notificationDeliveries.status, "retrying"),
            ),
            /* A delivery delayed by a personal rule isn't late before it is due. */
            or(isNull(notificationDeliveries.dueAt), lt(notificationDeliveries.dueAt, olderThan)),
            /* A retry waits out its backoff first (it doubles each attempt), so add that wait. */
            sql`${notificationDeliveries.updatedAt} + make_interval(secs => ${notificationDeliveries.backoffMs} * power(2, greatest(${notificationDeliveries.attempts} - 1, 0)) / 1000.0) < ${olderThan.toISOString()}::timestamptz`,
          ),
        )
        .orderBy(asc(notificationDeliveries.updatedAt))
        .limit(limit);
    },

    /* Deliveries waiting for a personal rule's delay; their delayed jobs are rebuilt from these. */
    async scheduled(tx: DbOrTx, after: Date, limit: number): Promise<DeliveryRow[]> {
      return tx
        .select()
        .from(notificationDeliveries)
        .where(
          and(
            eq(notificationDeliveries.status, "pending"),
            gt(notificationDeliveries.dueAt, after),
          ),
        )
        .orderBy(asc(notificationDeliveries.dueAt))
        .limit(limit);
    },

    /* Fallback notices: true if this call claimed the hour for the workspace. */
    async claimFallbackHour(tx: DbOrTx, workspaceId: string, hourStart: Date): Promise<boolean> {
      const rows = await tx
        .insert(alertFallbackNotices)
        .values({ workspaceId, hourStart })
        .onConflictDoNothing()
        .returning({ workspaceId: alertFallbackNotices.workspaceId });
      return rows.length > 0;
    },
  };
}
