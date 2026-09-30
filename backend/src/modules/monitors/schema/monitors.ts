/*
 * Tables owned by the monitors module (PRODUCT.md §7.4, §8): monitors, monitor_groups, tags,
 * monitor_tags and monitor_config_changes (the global change feed probes sync from).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
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
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { MonitorConfig } from "@app/shared";
import { organization } from "../../../infra/auth/schema.js";

export interface MonitorPolicies {
  minFailingRegions: number;
  recoverySuccesses: number;
  degradedLatencyMs?: number | undefined;
  degradedAfterChecks: number;
  upsideDown: boolean;
  reminderMinutes?: number | undefined;
}

export const monitorGroups = pgTable(
  "monitor_groups",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("monitor_groups_workspace_name_uq").on(t.workspaceId, t.name)],
);

export const monitors = pgTable(
  "monitors",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    type: text("type").$type<MonitorConfig["type"]>().notNull(),
    name: text("name").notNull(),
    /* Config without secrets; secrets live encrypted in secrets_enc. */
    config: jsonb("config").$type<MonitorConfig>().notNull(),
    secretsEnc: text("secrets_enc"),
    intervalS: integer("interval_s").notNull(),
    timeoutMs: integer("timeout_ms").notNull(),
    regions: text("regions").array().notNull(),
    policies: jsonb("policies").$type<MonitorPolicies>().notNull(),
    severity: text("severity").$type<"critical" | "high" | "low">().notNull(),
    alertPolicyId: uuid("alert_policy_id"),
    groupId: uuid("group_id").references(() => monitorGroups.id, { onDelete: "set null" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => monitors.id, {
      onDelete: "set null",
    }),
    paused: boolean("paused").notNull().default(false),
    /* "user" or "plan_limit" (downgrades pause, never delete: §5). */
    pausedReason: text("paused_reason").$type<"user" | "plan_limit">(),
    /* Sequence of the last change in monitor_config_changes. */
    configSeq: bigint("config_seq", { mode: "number" }).notNull().default(0),
    runbookUrl: text("runbook_url"),
    notes: text("notes"),
    publicName: text("public_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("monitors_workspace_idx").on(t.workspaceId, t.id),
    index("monitors_parent_idx")
      .on(t.parentId)
      .where(sql`${t.parentId} is not null`),
  ],
);

export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tags_workspace_name_uq").on(t.workspaceId, t.name)],
);

export const monitorTags = pgTable(
  "monitor_tags",
  {
    monitorId: uuid("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.monitorId, t.tagId] }),
    index("monitor_tags_tag_idx").on(t.tagId),
  ],
);

/* Global change feed: every create, update, pause, resume or delete appends a row (§7.6). */
export const monitorConfigChanges = pgTable(
  "monitor_config_changes",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    monitorId: uuid("monitor_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    op: text("op").$type<"upsert" | "delete">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("monitor_config_changes_monitor_idx").on(t.monitorId, t.seq)],
);

export type MonitorRow = typeof monitors.$inferSelect;
export type MonitorGroupRow = typeof monitorGroups.$inferSelect;
