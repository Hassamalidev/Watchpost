/*
 * Drizzle queries for the billing module's tables. Tenant reads go through tenantWhere; the lookups
 * by Paddle ID and the sweeps are system-level (webhooks and jobs have no session).
 */
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, ne, sql } from "drizzle-orm";
import type { PlanKey } from "@app/shared";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import type { DbOrTx } from "../../infra/db/index.js";
import { tenantWhere } from "../../infra/db/tenancy.js";
import {
  billingAccounts,
  billingEvents,
  subscriptionPayments,
  subscriptions,
  trialNotices,
  type BillingAccountRow,
  type BillingEventRow,
  type NewSubscriptionRow,
  type SubscriptionRow,
} from "./schema/billing.js";

export type BillingRepository = ReturnType<typeof createBillingRepository>;

export function createBillingRepository() {
  return {
    /* The workspace's subscription that is not canceled, if any (at most one, by a unique index). */
    async liveSubscription(
      db: DbOrTx,
      scope: WorkspaceScope,
    ): Promise<SubscriptionRow | undefined> {
      const [row] = await db
        .select()
        .from(subscriptions)
        .where(tenantWhere(scope, subscriptions, ne(subscriptions.status, "canceled")))
        .limit(1);
      return row;
    },

    async latestSubscription(
      db: DbOrTx,
      scope: WorkspaceScope,
    ): Promise<SubscriptionRow | undefined> {
      const [row] = await db
        .select()
        .from(subscriptions)
        .where(tenantWhere(scope, subscriptions))
        .orderBy(desc(subscriptions.createdAt))
        .limit(1);
      return row;
    },

    /* System-level: webhooks identify a subscription by Paddle's ID. Locks the row when asked. */
    async subscriptionByPaddleId(
      db: DbOrTx,
      paddleSubscriptionId: string,
      forUpdate = false,
    ): Promise<SubscriptionRow | undefined> {
      const query = db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.paddleSubscriptionId, paddleSubscriptionId))
        .limit(1);
      const rows = forUpdate ? await query.for("update") : await query;
      return rows[0];
    },

    async insertSubscription(db: DbOrTx, row: NewSubscriptionRow): Promise<SubscriptionRow> {
      const [created] = await db.insert(subscriptions).values(row).returning();
      if (created === undefined) throw new Error("subscription insert returned no row");
      return created;
    },

    async updateSubscription(
      db: DbOrTx,
      id: string,
      patch: Partial<Omit<NewSubscriptionRow, "id" | "workspaceId" | "paddleSubscriptionId">>,
    ): Promise<SubscriptionRow> {
      const [row] = await db
        .update(subscriptions)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(eq(subscriptions.id, id))
        .returning();
      if (row === undefined) throw new Error("subscription update matched no row");
      return row;
    },

    /* System-level: subscriptions Paddle may still change, paged by ID (reconcile, monthly grants). */
    async liveSubscriptions(
      db: DbOrTx,
      options: { afterId?: string | undefined; limit: number },
    ): Promise<SubscriptionRow[]> {
      return db
        .select()
        .from(subscriptions)
        .where(
          and(
            ne(subscriptions.status, "canceled"),
            options.afterId ? gt(subscriptions.id, options.afterId) : undefined,
          ),
        )
        .orderBy(asc(subscriptions.id))
        .limit(options.limit);
    },

    async account(
      db: DbOrTx,
      workspaceId: string,
      forUpdate = false,
    ): Promise<BillingAccountRow | undefined> {
      const query = db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.workspaceId, workspaceId))
        .limit(1);
      const rows = forUpdate ? await query.for("update") : await query;
      return rows[0];
    },

    /* Which of these workspaces already have a billing account. */
    async existingAccounts(db: DbOrTx, workspaceIds: string[]): Promise<Set<string>> {
      if (workspaceIds.length === 0) return new Set();
      const rows = await db
        .select({ workspaceId: billingAccounts.workspaceId })
        .from(billingAccounts)
        .where(inArray(billingAccounts.workspaceId, workspaceIds));
      return new Set(rows.map((r) => r.workspaceId));
    },

    /* True only if this call created the account. */
    async insertAccountIfMissing(
      db: DbOrTx,
      values: { workspaceId: string; effectivePlan: PlanKey },
    ): Promise<boolean> {
      const rows = await db
        .insert(billingAccounts)
        .values(values)
        .onConflictDoNothing({ target: billingAccounts.workspaceId })
        .returning({ workspaceId: billingAccounts.workspaceId });
      return rows.length > 0;
    },

    async updateAccount(
      db: DbOrTx,
      workspaceId: string,
      patch: Partial<
        Pick<
          BillingAccountRow,
          "effectivePlan" | "nextCheckAt" | "paddleCustomerId" | "foundingNumber"
        >
      >,
    ): Promise<void> {
      await db
        .update(billingAccounts)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(eq(billingAccounts.workspaceId, workspaceId));
    },

    /* Workspaces whose plan may have changed on its own (trial, grace or downgrade date passed). */
    async dueAccounts(db: DbOrTx, now: Date, limit: number): Promise<string[]> {
      const rows = await db
        .select({ workspaceId: billingAccounts.workspaceId })
        .from(billingAccounts)
        .where(and(isNotNull(billingAccounts.nextCheckAt), lte(billingAccounts.nextCheckAt, now)))
        .orderBy(asc(billingAccounts.nextCheckAt))
        .limit(limit);
      return rows.map((r) => r.workspaceId);
    },

    async foundingCount(db: DbOrTx): Promise<number> {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(billingAccounts)
        .where(isNotNull(billingAccounts.foundingNumber));
      return row?.n ?? 0;
    },

    /*
     * Gives the workspace the next founding number if it has none and slots remain. One caller at a
     * time (advisory lock), so two activations can't take the same number.
     */
    async claimFoundingNumber(db: DbOrTx, workspaceId: string, slots: number): Promise<void> {
      await db.execute(sql`select pg_advisory_xact_lock(hashtext('billing-founding-number'))`);
      await db.execute(sql`
        update ${billingAccounts}
        set founding_number = (select coalesce(max(founding_number), 0) + 1 from ${billingAccounts}),
            updated_at = now()
        where workspace_id = ${workspaceId}
          and founding_number is null
          and (select count(*) from ${billingAccounts} where founding_number is not null) < ${slots}`);
    },

    /* Stores a verified webhook; false when Paddle already delivered this event. */
    async insertEvent(
      db: DbOrTx,
      row: { id: string; eventId: string; type: string; occurredAt: Date; payload: unknown },
    ): Promise<boolean> {
      const rows = await db
        .insert(billingEvents)
        .values(row)
        .onConflictDoNothing({ target: billingEvents.eventId })
        .returning({ id: billingEvents.id });
      return rows.length > 0;
    },

    async eventForUpdate(db: DbOrTx, eventId: string): Promise<BillingEventRow | undefined> {
      const [row] = await db
        .select()
        .from(billingEvents)
        .where(eq(billingEvents.eventId, eventId))
        .limit(1)
        .for("update");
      return row;
    },

    async markEventProcessed(db: DbOrTx, id: string, outcome: string, at: Date): Promise<void> {
      await db
        .update(billingEvents)
        .set({ processedAt: at, outcome, lastError: null })
        .where(eq(billingEvents.id, id));
    },

    async recordEventFailure(db: DbOrTx, eventId: string, error: string): Promise<void> {
      await db
        .update(billingEvents)
        .set({ attempts: sql`${billingEvents.attempts} + 1`, lastError: error.slice(0, 2_000) })
        .where(and(eq(billingEvents.eventId, eventId), isNull(billingEvents.processedAt)));
    },

    /* Stored events nobody processed yet (the job was lost or keeps failing), oldest first. */
    async unprocessedEvents(
      db: DbOrTx,
      receivedBefore: Date,
      maxAttempts: number,
      limit: number,
    ): Promise<Array<{ eventId: string; attempts: number }>> {
      return db
        .select({ eventId: billingEvents.eventId, attempts: billingEvents.attempts })
        .from(billingEvents)
        .where(
          and(
            isNull(billingEvents.processedAt),
            lt(billingEvents.receivedAt, receivedBefore),
            lt(billingEvents.attempts, maxAttempts),
          ),
        )
        .orderBy(asc(billingEvents.receivedAt))
        .limit(limit);
    },

    /* Records a collected payment for a billing period; false when the transaction is already known. */
    async insertPayment(
      db: DbOrTx,
      row: {
        id: string;
        paddleSubscriptionId: string;
        transactionId: string;
        periodStart: Date | null;
        periodEnd: Date | null;
      },
    ): Promise<boolean> {
      const rows = await db
        .insert(subscriptionPayments)
        .values(row)
        .onConflictDoNothing({ target: subscriptionPayments.transactionId })
        .returning({ id: subscriptionPayments.id });
      return rows.length > 0;
    },

    /* Collected payments of a subscription, newest first (a handful: one per billing period). */
    async payments(
      db: DbOrTx,
      paddleSubscriptionId: string,
      limit = 24,
    ): Promise<Array<{ id: string; periodStart: Date | null; periodEnd: Date | null }>> {
      return db
        .select({
          id: subscriptionPayments.id,
          periodStart: subscriptionPayments.periodStart,
          periodEnd: subscriptionPayments.periodEnd,
        })
        .from(subscriptionPayments)
        .where(eq(subscriptionPayments.paddleSubscriptionId, paddleSubscriptionId))
        .orderBy(desc(subscriptionPayments.createdAt))
        .limit(limit);
    },

    async setPaymentPeriod(db: DbOrTx, id: string, periodStart: Date, periodEnd: Date) {
      await db
        .update(subscriptionPayments)
        .set({ periodStart, periodEnd })
        .where(eq(subscriptionPayments.id, id));
    },

    /*
     * Serializes everything that touches one Paddle subscription for the rest of the transaction, so
     * a payment and a subscription webhook arriving together can't both miss each other.
     */
    async lockPaddleSubscription(db: DbOrTx, paddleSubscriptionId: string): Promise<void> {
      await db.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${paddleSubscriptionId}, 11))`,
      );
    },

    /* Trial notices already handled for these workspaces, as "workspaceId:kind". */
    async handledTrialNotices(db: DbOrTx, workspaceIds: string[]): Promise<Set<string>> {
      if (workspaceIds.length === 0) return new Set();
      const rows = await db
        .select({ workspaceId: trialNotices.workspaceId, kind: trialNotices.kind })
        .from(trialNotices)
        .where(inArray(trialNotices.workspaceId, workspaceIds));
      return new Set(rows.map((r) => `${r.workspaceId}:${r.kind}`));
    },

    /* Marks notices as handled without sending anything (too late to be useful). */
    async markTrialNotices(
      db: DbOrTx,
      rows: Array<{ workspaceId: string; kind: string }>,
    ): Promise<void> {
      if (rows.length === 0) return;
      await db.insert(trialNotices).values(rows).onConflictDoNothing();
    },

    /* Records that a trial email is going out; false if it was already sent. */
    async claimTrialNotice(db: DbOrTx, workspaceId: string, kind: string): Promise<boolean> {
      const rows = await db
        .insert(trialNotices)
        .values({ workspaceId, kind })
        .onConflictDoNothing()
        .returning({ kind: trialNotices.kind });
      return rows.length > 0;
    },
  };
}
