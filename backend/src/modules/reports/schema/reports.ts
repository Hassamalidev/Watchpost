/*
 * Tables owned by the reports module (PRODUCT.md §7.4): which weekly digests went out, the
 * schedules that email SLA reports to people inside and outside the workspace, and which monthly
 * emails went out.
 */
import type { ReportFrequency, ReportTargetKind } from "@app/shared";
import { boolean, index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "../../../infra/auth/schema.js";

export const digestSends = pgTable(
  "digest_sends",
  {
    workspaceId: uuid("workspace_id").notNull(),
    /* Monday 00:00 UTC of the week the digest covers. */
    weekStart: timestamp("week_start", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.weekStart] })],
);

export const reportSchedules = pgTable(
  "report_schedules",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    targetKind: text("target_kind").$type<ReportTargetKind>().notNull(),
    /* The monitor, group or status page; null for the whole workspace. */
    targetId: uuid("target_id"),
    frequency: text("frequency").$type<ReportFrequency>().notNull(),
    recipients: text("recipients").array().notNull(),
    excludeMaintenance: boolean("exclude_maintenance").notNull().default(true),
    /* White-label: the name printed on the PDF instead of ours. */
    brandName: text("brand_name"),
    /* Start of the last period that was sent, so a period goes out once. */
    lastPeriodStart: timestamp("last_period_start", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("report_schedules_workspace_idx").on(t.workspaceId),
    index("report_schedules_due_idx").on(t.frequency, t.id),
  ],
);

/* The monthly uptime email to a workspace's owners and admins: once per workspace and month. */
export const reportSends = pgTable(
  "report_sends",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.kind, t.periodStart] })],
);
