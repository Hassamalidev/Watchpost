/*
 * Tables owned by the statuspages module (PRODUCT.md §7.4, §8). A page has ordered components; a
 * component shows a monitor's state or one set by hand. Page incidents are written for the public and
 * are separate from the internal incidents in the `incidents` module.
 */
import type {
  MANUAL_COMPONENT_STATUSES,
  StatusBranding,
  StatusImpact,
  StatusIncidentStatus,
  StatusPageSettings,
} from "@app/shared";
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

export const statusPages = pgTable(
  "status_pages",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /* The subdomain: unique across every workspace. */
    slug: text("slug").notNull(),
    /* The customer's own host name, lowercase; served only once verified (§16). */
    customDomain: text("custom_domain"),
    domainVerifiedAt: timestamp("domain_verified_at", { withTimezone: true }),
    domainCheckedAt: timestamp("domain_checked_at", { withTimezone: true }),
    /* Why the last DNS check failed, in plain words; null when it passed or never ran. */
    domainError: text("domain_error"),
    branding: jsonb("branding").$type<StatusBranding>().notNull(),
    /* "public" for now; password, SSO and IP allowlist come with private pages (P7). */
    visibility: text("visibility").$type<"public">().notNull().default("public"),
    settings: jsonb("settings").$type<StatusPageSettings>().notNull(),
    /* Off hides the page from the public; the team still sees it in the app. */
    published: boolean("published").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("status_pages_slug_uq").on(t.slug),
    uniqueIndex("status_pages_custom_domain_uq")
      .on(t.customDomain)
      .where(sql`${t.customDomain} is not null`),
    index("status_pages_workspace_idx").on(t.workspaceId, t.createdAt),
  ],
);

export const statusComponents = pgTable(
  "status_components",
  {
    id: uuid("id").primaryKey(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => statusPages.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /* No foreign key: monitors belong to another module. A deleted monitor unlinks by event. */
    monitorId: uuid("monitor_id"),
    manualStatus: text("manual_status").$type<(typeof MANUAL_COMPONENT_STATUSES)[number]>(),
    groupName: text("group_name"),
    showUptime: boolean("show_uptime").notNull().default(true),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("status_components_page_idx").on(t.pageId, t.position),
    index("status_components_monitor_idx")
      .on(t.monitorId)
      .where(sql`${t.monitorId} is not null`),
  ],
);

export const statusIncidents = pgTable(
  "status_incidents",
  {
    id: uuid("id").primaryKey(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => statusPages.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    title: text("title").notNull(),
    status: text("status").$type<StatusIncidentStatus>().notNull(),
    impact: text("impact").$type<StatusImpact>().notNull(),
    componentIds: jsonb("component_ids").$type<string[]>().notNull(),
    /* A draft is seen by the team only. */
    published: boolean("published").notNull().default(true),
    /* Set when the page opened it by itself: the monitor that stayed down. */
    autoMonitorId: uuid("auto_monitor_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("status_incidents_page_idx").on(t.pageId, t.startedAt.desc()),
    /* One open automatic incident per page and monitor, whatever races. */
    uniqueIndex("status_incidents_one_auto_uq")
      .on(t.pageId, t.autoMonitorId)
      .where(sql`${t.autoMonitorId} is not null and ${t.resolvedAt} is null`),
  ],
);

export const statusUpdates = pgTable(
  "status_updates",
  {
    id: uuid("id").primaryKey(),
    statusIncidentId: uuid("status_incident_id")
      .notNull()
      .references(() => statusIncidents.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    status: text("status").$type<StatusIncidentStatus>().notNull(),
    body: text("body").notNull(),
    aiDrafted: boolean("ai_drafted").notNull().default(false),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("status_updates_incident_idx").on(t.statusIncidentId, t.createdAt)],
);

export type StatusPageRow = typeof statusPages.$inferSelect;
export type StatusComponentRow = typeof statusComponents.$inferSelect;
export type StatusIncidentRow = typeof statusIncidents.$inferSelect;
export type StatusUpdateRow = typeof statusUpdates.$inferSelect;
