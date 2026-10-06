/*
 * Tables owned by the billing module (PRODUCT.md §8, §11).
 * - subscriptions: one row per Paddle subscription, kept in step with Paddle by webhooks and the
 *   nightly reconcile. `last_event_at` makes out-of-order webhooks harmless.
 * - billing_accounts: one row per workspace with the plan we last announced (billing.plan_changed
 *   fires when it changes) and the next moment the plan can change on its own (trial end, grace end,
 *   downgrade date), which the billing clock sweep watches.
 * - billing_events: every verified Paddle webhook, stored before it is processed.
 * - subscription_payments: billing periods Paddle actually collected money for. Credits and upstream
 *   funding follow these, never a subscription that merely says "active".
 * - trial_notices: which trial emails a workspace already got.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { BillingInterval, PaidPlanKey, PlanKey, SubscriptionStatus } from "@app/shared";
import { organization } from "../../../infra/auth/schema.js";

export interface SubscriptionItem {
  priceId: string;
  quantity: number;
}

export interface ScheduledChange {
  action: "cancel" | "pause" | "resume";
  effectiveAt: string;
  resumeAt: string | null;
}

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    paddleSubscriptionId: text("paddle_subscription_id").notNull(),
    paddleCustomerId: text("paddle_customer_id").notNull(),
    status: text("status").$type<SubscriptionStatus>().notNull(),
    planKey: text("plan_key").$type<PaidPlanKey>().notNull(),
    billingInterval: text("billing_interval").$type<BillingInterval>().notNull(),
    items: jsonb("items").$type<SubscriptionItem[]>().notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    /* The newest billing period with a completed payment, announced with billing.period_renewed. */
    paidPeriodStart: timestamp("paid_period_start", { withTimezone: true }),
    paidPeriodEnd: timestamp("paid_period_end", { withTimezone: true }),
    scheduledChange: jsonb("scheduled_change").$type<ScheduledChange>(),
    /* When the current overdue payment first failed; paid features stay on for the grace period. */
    pastDueSince: timestamp("past_due_since", { withTimezone: true }),
    /* After a downgrade the previous (higher) plan stays until the period the customer paid for ends. */
    heldPlanKey: text("held_plan_key").$type<PlanKey>(),
    heldUntil: timestamp("held_until", { withTimezone: true }),
    /* The items in force before the downgrade: paid add-ons count until the hold ends too. */
    heldItems: jsonb("held_items").$type<SubscriptionItem[]>(),
    /* Paddle discount on the subscription (the founding-customer discount is recognized by ID). */
    discountId: text("discount_id"),
    cancelReason: text("cancel_reason"),
    cancelComment: text("cancel_comment"),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    /* occurred_at of the newest Paddle event applied; older events are ignored (§11). */
    lastEventAt: timestamp("last_event_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("subscriptions_paddle_id_uq").on(t.paddleSubscriptionId),
    /* One live subscription per workspace; canceled ones stay as history. */
    uniqueIndex("subscriptions_live_workspace_uq")
      .on(t.workspaceId)
      .where(sql`${t.status} <> 'canceled'`),
    index("subscriptions_workspace_idx").on(t.workspaceId, t.createdAt),
  ],
);

export const billingAccounts = pgTable(
  "billing_accounts",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    /* The plan last announced with billing.plan_changed. */
    effectivePlan: text("effective_plan").$type<PlanKey>().notNull(),
    /* Next time the plan can change without a webhook; null when nothing is pending. */
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
    /* Kept after a subscription ends so the customer can still open invoices in the portal. */
    paddleCustomerId: text("paddle_customer_id"),
    /* 1..100 for founding customers (30% off for life, §5). */
    foundingNumber: integer("founding_number"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("billing_accounts_next_check_idx")
      .on(t.nextCheckAt)
      .where(sql`${t.nextCheckAt} is not null`),
    uniqueIndex("billing_accounts_founding_uq")
      .on(t.foundingNumber)
      .where(sql`${t.foundingNumber} is not null`),
  ],
);

export const billingEvents = pgTable(
  "billing_events",
  {
    id: uuid("id").primaryKey(),
    /* Paddle's event ID (evt_…); the unique index makes redeliveries harmless. */
    eventId: text("event_id").notNull(),
    type: text("type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    /* What processing did: applied, stale, ignored, unlinked. */
    outcome: text("outcome"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
  },
  (t) => [
    uniqueIndex("billing_events_event_id_uq").on(t.eventId),
    index("billing_events_unprocessed_idx")
      .on(t.receivedAt)
      .where(sql`${t.processedAt} is null`),
  ],
);

export const subscriptionPayments = pgTable(
  "subscription_payments",
  {
    id: uuid("id").primaryKey(),
    /* Paddle's subscription ID: the payment can arrive before the subscription webhook does. */
    paddleSubscriptionId: text("paddle_subscription_id").notNull(),
    transactionId: text("transaction_id").notNull(),
    /* Null when the first payment arrived before the subscription and carried no period yet. */
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("subscription_payments_transaction_uq").on(t.transactionId),
    index("subscription_payments_subscription_idx").on(t.paddleSubscriptionId, t.periodEnd),
  ],
);

export const trialNotices = pgTable(
  "trial_notices",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /* day1, day7, day12 or ended: each is sent once. */
    kind: text("kind").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.kind] })],
);

export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type NewSubscriptionRow = typeof subscriptions.$inferInsert;
export type BillingAccountRow = typeof billingAccounts.$inferSelect;
export type BillingEventRow = typeof billingEvents.$inferSelect;
