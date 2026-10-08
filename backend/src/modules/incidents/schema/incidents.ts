/*
 * Tables owned by the incidents module (PRODUCT.md §6.3, §8). The database enforces one open incident
 * per monitor and per inbound dedup key (partial unique indexes), so concurrent evaluations can't
 * open duplicates.
 */
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

export type IncidentStatus = "triggered" | "acknowledged" | "snoozed" | "resolved";
export type IncidentSource = "monitor" | "heartbeat" | "inbound" | "manual" | "expiry" | "drill";
export type IncidentSeverity = "critical" | "high" | "low";

export const incidents = pgTable(
  "incidents",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /* Per-workspace number for humans (#482), from workspace_settings.incident_seq. */
    number: integer("number").notNull(),
    source: text("source").$type<IncidentSource>().notNull(),
    monitorId: uuid("monitor_id"),
    inboundId: uuid("inbound_id"),
    dedupKey: text("dedup_key"),
    title: text("title").notNull(),
    severity: text("severity").$type<IncidentSeverity>().notNull(),
    status: text("status").$type<IncidentStatus>().notNull().default("triggered"),
    causeCode: text("cause_code"),
    failingRegions: text("failing_regions")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    evidence: jsonb("evidence").$type<Record<string, unknown>>(),
    aiSummary: jsonb("ai_summary").$type<Record<string, unknown>>(),
    flapping: boolean("flapping").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
    ackedBy: uuid("acked_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by"),
    autoResolved: boolean("auto_resolved").notNull().default(false),
    falseAlarm: boolean("false_alarm").notNull().default(false),
    escalationPolicyId: uuid("escalation_policy_id"),
    escRound: integer("esc_round").notNull().default(0),
    escStep: integer("esc_step").notNull().default(0),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    suppressedByIncidentId: uuid("suppressed_by_incident_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /* Expiry warnings are separate (deduplicated by key) so they never hide an outage. */
    uniqueIndex("incidents_one_open_per_monitor_uq")
      .on(t.monitorId)
      .where(
        sql`${t.status} <> 'resolved' and ${t.monitorId} is not null and ${t.source} <> 'expiry'`,
      ),
    uniqueIndex("incidents_one_open_per_dedup_uq")
      .on(t.workspaceId, t.dedupKey)
      .where(sql`${t.status} <> 'resolved' and ${t.dedupKey} is not null`),
    uniqueIndex("incidents_workspace_number_uq").on(t.workspaceId, t.number),
    index("incidents_workspace_started_idx").on(t.workspaceId, t.startedAt.desc()),
    index("incidents_suppressed_by_idx")
      .on(t.suppressedByIncidentId)
      .where(sql`${t.suppressedByIncidentId} is not null`),
  ],
);

/* The timeline: every change to an incident writes one row (§9.3). */
export const incidentEvents = pgTable(
  "incident_events",
  {
    id: uuid("id").primaryKey(),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    type: text("type").notNull(),
    /* "system", or a user ID. */
    actor: text("actor").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index("incident_events_incident_at_idx").on(t.incidentId, t.at)],
);

export const incidentComments = pgTable(
  "incident_comments",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    authorId: uuid("author_id").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("incident_comments_incident_idx").on(t.incidentId, t.createdAt)],
);

/* One written review per incident: Markdown a person edits, perhaps started by AI (§6.9). */
export const postmortems = pgTable("postmortems", {
  incidentId: uuid("incident_id")
    .primaryKey()
    .references(() => incidents.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull(),
  markdown: text("markdown").notNull(),
  /* The AI generation the text started from; null when a person wrote it from nothing. */
  aiGenerationId: uuid("ai_generation_id"),
  updatedBy: uuid("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PostmortemRow = typeof postmortems.$inferSelect;
export type IncidentRow = typeof incidents.$inferSelect;
export type IncidentCommentRow = typeof incidentComments.$inferSelect;
export type IncidentEventRow = typeof incidentEvents.$inferSelect;
