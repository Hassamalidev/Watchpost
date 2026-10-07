/*
 * Tables owned by the alerting module (PRODUCT.md §7.4, §8, §9.4). A notification_deliveries row is
 * one alert event to one destination; the unique (event_key, destination_key) pair makes planning
 * idempotent, and the row's status makes sending at most once per successful attempt.
 */
import type {
  AlertEventKind,
  AlertPolicyRules,
  ContactMethodType,
  EscalationStep,
} from "@app/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
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
import { organization } from "../../../infra/auth/schema.js";

export type DeliveryStatus = "pending" | "sending" | "retrying" | "sent" | "failed" | "skipped";

export const alertPolicies = pgTable(
  "alert_policies",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /* Used by monitors without a policy of their own; exactly one per workspace. */
    isDefault: boolean("is_default").notNull().default(false),
    rules: jsonb("rules").$type<AlertPolicyRules>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("alert_policies_one_default_uq")
      .on(t.workspaceId)
      .where(sql`${t.isDefault}`),
  ],
);

export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    incidentId: uuid("incident_id").notNull(),
    /* The outbox event ID, or `reminder.<incident>.<dueAt>` for reminders. */
    eventKey: text("event_key").notNull(),
    /* `channel:<id>`, or `user:<id>:method:<id>` for a person's own contact method. */
    destinationKey: text("destination_key").notNull(),
    channelId: uuid("channel_id"),
    /* Set together for a delivery to a person: who, through which of their contact methods. */
    userId: uuid("user_id"),
    contactMethodId: uuid("contact_method_id"),
    contactType: text("contact_type").$type<ContactMethodType>(),
    contactAddress: text("contact_address"),
    /* When a personal rule or a group's 15-second window delays the delivery; null means at once. */
    dueAt: timestamp("due_at", { withTimezone: true }),
    /*
     * `group:<groupId>:<windowStart>` when the monitor's group collects failures into one message
     * (§9.6): the first delivery of a key and destination is sent and names the others.
     */
    groupKey: text("group_key"),
    kind: text("kind").$type<AlertEventKind>().notNull(),
    /* Display name of whoever acted, for "Acknowledged by Sara". */
    actorName: text("actor_name"),
    status: text("status").$type<DeliveryStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    /* From the channel type's retry policy (webhooks retry for about an hour). */
    maxAttempts: integer("max_attempts").notNull().default(5),
    backoffMs: integer("backoff_ms").notNull().default(8_000),
    providerRef: text("provider_ref"),
    error: text("error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("notification_deliveries_event_destination_uq").on(t.eventKey, t.destinationKey),
    index("notification_deliveries_incident_idx").on(t.incidentId, t.createdAt),
    index("notification_deliveries_group_idx")
      .on(t.groupKey, t.destinationKey)
      .where(sql`${t.groupKey} is not null`),
    index("notification_deliveries_unfinished_idx")
      .on(t.updatedAt)
      .where(sql`${t.status} in ('pending', 'sending', 'retrying')`),
  ],
);

/* One row per workspace and hour in which admins were told about failing channels. */
export const alertFallbackNotices = pgTable(
  "alert_fallback_notices",
  {
    workspaceId: uuid("workspace_id").notNull(),
    hourStart: timestamp("hour_start", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.hourStart] })],
);

/*
 * One row per incident that is being escalated (§9.5). The policy's steps are copied in when the
 * incident opens, so editing the policy doesn't change an escalation under way. `next_step` counts
 * across rounds; the timer job for a step is rebuilt from `next_step` and `next_due_at`.
 */
export const escalations = pgTable(
  "escalations",
  {
    incidentId: uuid("incident_id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    policyId: uuid("policy_id").notNull(),
    policyName: text("policy_name").notNull(),
    steps: jsonb("steps").$type<EscalationStep[]>().notNull(),
    repeat: integer("repeat").notNull().default(0),
    nextStep: integer("next_step").notNull().default(0),
    nextDueAt: timestamp("next_due_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    finishedReason: text("finished_reason").$type<"acknowledged" | "resolved" | "exhausted">(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("escalations_unfinished_idx")
      .on(t.nextDueAt)
      .where(sql`${t.finishedAt} is null`),
  ],
);

export type EscalationRow = typeof escalations.$inferSelect;
export type AlertPolicyRow = typeof alertPolicies.$inferSelect;
export type DeliveryRow = typeof notificationDeliveries.$inferSelect;
