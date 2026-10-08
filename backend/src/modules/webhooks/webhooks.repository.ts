/* Queries on webhook_endpoints and webhook_deliveries, owned by the webhooks module. */
import { and, asc, desc, eq, lt, lte, sql } from "drizzle-orm";
import type { WebhookEnvelope } from "@app/shared";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import { tenantWhere, withWorkspace, type DbOrTx } from "../../infra/db/index.js";
import { webhookDeliveries, webhookEndpoints } from "./schema/webhooks.js";

export type WebhookEndpointRow = typeof webhookEndpoints.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
type EndpointValues = Omit<typeof webhookEndpoints.$inferInsert, "workspaceId">;

export type WebhooksRepository = ReturnType<typeof createWebhooksRepository>;

export function createWebhooksRepository(db: DbOrTx) {
  return {
    async list(scope: WorkspaceScope): Promise<WebhookEndpointRow[]> {
      return db
        .select()
        .from(webhookEndpoints)
        .where(tenantWhere(scope, webhookEndpoints))
        .orderBy(asc(webhookEndpoints.createdAt), asc(webhookEndpoints.id));
    },

    async count(scope: WorkspaceScope): Promise<number> {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(webhookEndpoints)
        .where(tenantWhere(scope, webhookEndpoints));
      return row?.n ?? 0;
    },

    async find(scope: WorkspaceScope, id: string): Promise<WebhookEndpointRow | undefined> {
      const rows = await db
        .select()
        .from(webhookEndpoints)
        .where(tenantWhere(scope, webhookEndpoints, eq(webhookEndpoints.id, id)));
      return rows[0];
    },

    async insert(scope: WorkspaceScope, values: EndpointValues): Promise<WebhookEndpointRow> {
      const rows = await db
        .insert(webhookEndpoints)
        .values(withWorkspace(scope, values))
        .returning();
      const row = rows[0];
      if (row === undefined) throw new Error("webhook endpoint insert returned no row");
      return row;
    },

    async update(
      scope: WorkspaceScope,
      id: string,
      values: Partial<EndpointValues>,
    ): Promise<WebhookEndpointRow | undefined> {
      const rows = await db
        .update(webhookEndpoints)
        .set(values)
        .where(tenantWhere(scope, webhookEndpoints, eq(webhookEndpoints.id, id)))
        .returning();
      return rows[0];
    },

    async remove(scope: WorkspaceScope, id: string): Promise<boolean> {
      const rows = await db
        .delete(webhookEndpoints)
        .where(tenantWhere(scope, webhookEndpoints, eq(webhookEndpoints.id, id)))
        .returning({ id: webhookEndpoints.id });
      return rows.length > 0;
    },

    /* System: the endpoints of a workspace that are switched on. */
    async enabledIn(workspaceId: string): Promise<WebhookEndpointRow[]> {
      return db
        .select()
        .from(webhookEndpoints)
        .where(
          and(eq(webhookEndpoints.workspaceId, workspaceId), eq(webhookEndpoints.enabled, true)),
        );
    },

    /* System: an endpoint by ID, for a delivery that already belongs to it. */
    async endpointById(id: string): Promise<WebhookEndpointRow | undefined> {
      const rows = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id));
      return rows[0];
    },

    /* System: counts a delivery that worked. */
    async recordSuccess(id: string, now: Date): Promise<void> {
      await db
        .update(webhookEndpoints)
        .set({ consecutiveFailures: 0, lastDeliveryAt: now })
        .where(eq(webhookEndpoints.id, id));
    },

    /* System: counts a delivery that failed for good; answers how many have in a row. */
    async recordFailure(id: string): Promise<number> {
      const rows = await db
        .update(webhookEndpoints)
        .set({ consecutiveFailures: sql`${webhookEndpoints.consecutiveFailures} + 1` })
        .where(eq(webhookEndpoints.id, id))
        .returning({ n: webhookEndpoints.consecutiveFailures });
      return rows[0]?.n ?? 0;
    },

    async disable(id: string, reason: string, now: Date): Promise<void> {
      await db
        .update(webhookEndpoints)
        .set({ enabled: false, disabledReason: reason, updatedAt: now })
        .where(eq(webhookEndpoints.id, id));
    },

    /* The delivery, or undefined when this event already has one for the endpoint. */
    async insertDelivery(values: {
      id: string;
      workspaceId: string;
      endpointId: string;
      eventKey: string;
      eventType: string;
      payload: WebhookEnvelope;
      manual: boolean;
      now: Date;
    }): Promise<WebhookDeliveryRow | undefined> {
      const rows = await db
        .insert(webhookDeliveries)
        .values({
          id: values.id,
          workspaceId: values.workspaceId,
          endpointId: values.endpointId,
          eventKey: values.eventKey,
          eventType: values.eventType,
          payload: values.payload,
          manual: values.manual,
          nextAttemptAt: values.now,
          createdAt: values.now,
        })
        .onConflictDoNothing()
        .returning();
      return rows[0];
    },

    /*
     * Takes a pending delivery that is due for one attempt: counts the attempt and moves its due
     * time `leaseMs` ahead, so another worker leaves it alone, and a crash here means it is tried
     * again when the lease runs out. Undefined when it isn't due or someone else took it.
     */
    async claim(id: string, now: Date, leaseMs: number): Promise<WebhookDeliveryRow | undefined> {
      const rows = await db
        .update(webhookDeliveries)
        .set({
          attempts: sql`${webhookDeliveries.attempts} + 1`,
          nextAttemptAt: new Date(now.getTime() + leaseMs),
        })
        .where(
          and(
            eq(webhookDeliveries.id, id),
            eq(webhookDeliveries.status, "pending"),
            lte(webhookDeliveries.nextAttemptAt, now),
          ),
        )
        .returning();
      return rows[0];
    },

    async finishDelivery(
      id: string,
      values: Pick<
        typeof webhookDeliveries.$inferInsert,
        "status" | "responseStatus" | "error" | "nextAttemptAt" | "deliveredAt"
      >,
    ): Promise<WebhookDeliveryRow | undefined> {
      const rows = await db
        .update(webhookDeliveries)
        .set(values)
        .where(eq(webhookDeliveries.id, id))
        .returning();
      return rows[0];
    },

    /* System: IDs of pending deliveries that are due, oldest first. */
    async dueDeliveryIds(now: Date, limit: number): Promise<string[]> {
      const rows = await db
        .select({ id: webhookDeliveries.id })
        .from(webhookDeliveries)
        .where(
          and(eq(webhookDeliveries.status, "pending"), lte(webhookDeliveries.nextAttemptAt, now)),
        )
        .orderBy(asc(webhookDeliveries.nextAttemptAt))
        .limit(limit);
      return rows.map((r) => r.id);
    },

    async deliveriesOf(
      scope: WorkspaceScope,
      endpointId: string,
      limit: number,
    ): Promise<WebhookDeliveryRow[]> {
      return db
        .select()
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.workspaceId, scope.workspaceId),
            eq(webhookDeliveries.endpointId, endpointId),
          ),
        )
        .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
        .limit(limit);
    },

    async findDelivery(
      scope: WorkspaceScope,
      endpointId: string,
      id: string,
    ): Promise<WebhookDeliveryRow | undefined> {
      const rows = await db
        .select()
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.workspaceId, scope.workspaceId),
            eq(webhookDeliveries.endpointId, endpointId),
            eq(webhookDeliveries.id, id),
          ),
        );
      return rows[0];
    },

    async deliveryById(id: string): Promise<WebhookDeliveryRow | undefined> {
      const rows = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id));
      return rows[0];
    },

    /* System: forgets deliveries older than we promise to keep them. */
    async deleteDeliveriesBefore(before: Date): Promise<number> {
      const rows = await db
        .delete(webhookDeliveries)
        .where(lt(webhookDeliveries.createdAt, before))
        .returning({ id: webhookDeliveries.id });
      return rows.length;
    },
  };
}
