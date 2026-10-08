/*
 * Tables owned by the webhooks module (PRODUCT.md §7.4, §8). An endpoint is a URL a workspace wants
 * events sent to; a delivery is one event for one endpoint, with what happened to it. Deliveries
 * are the queue: a pending row with a due time is all a worker needs to carry on after a crash.
 */
import type { WebhookDeliveryStatus, WebhookEnvelope, WebhookEventPattern } from "@app/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "../../../infra/auth/schema.js";

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    /* The signing secret, encrypted (infra/crypto). */
    secret: text("secret").notNull(),
    events: text("events").array().$type<WebhookEventPattern[]>().notNull(),
    /* A custom request body with {{placeholders}}; null sends the standard envelope. */
    bodyTemplate: text("body_template"),
    /* Custom request headers as JSON, encrypted; null when there are none. */
    headers: text("headers"),
    enabled: boolean("enabled").notNull().default(true),
    /* Why we switched it off (too many failures, 410 Gone); null when a person did, or it is on. */
    disabledReason: text("disabled_reason"),
    /* Deliveries in a row that failed for good; a success sets it back to 0. */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("webhook_endpoints_workspace_idx").on(t.workspaceId)],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    /* What the delivery is for (the outbox event's ID, or a new ID for a test or replay): once per endpoint. */
    eventKey: text("event_key").notNull(),
    eventType: text("event_type").notNull(),
    /* The envelope as it was when the event happened; a retry or replay sends the same one. */
    payload: jsonb("payload").$type<WebhookEnvelope>().notNull(),
    status: text("status").$type<WebhookDeliveryStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    responseStatus: integer("response_status"),
    error: text("error"),
    /* When the next attempt is due; also the lease while an attempt runs. Null once it is over. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    /* A test event or a replay started by a person. */
    manual: boolean("manual").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("webhook_deliveries_event_uq").on(t.endpointId, t.eventKey),
    index("webhook_deliveries_due_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    index("webhook_deliveries_endpoint_idx").on(t.endpointId, t.createdAt.desc()),
    index("webhook_deliveries_created_idx").on(t.createdAt),
  ],
);
