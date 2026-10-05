/*
 * Tables owned by the maintenance module (PRODUCT.md §7.4, §8). `starts_at`/`ends_at` are the first
 * occurrence; `rrule` repeats it in `timezone`. `active` is what the boundary sweep last saw, so a
 * start or an end is noticed exactly once.
 */
import type { MaintenanceScope } from "@app/shared";
import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "../../../infra/auth/schema.js";

export const maintenanceWindows = pgTable(
  "maintenance_windows",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    rrule: text("rrule"),
    timezone: text("timezone").notNull().default("UTC"),
    scope: jsonb("scope").$type<MaintenanceScope>().notNull(),
    suppressAlerts: boolean("suppress_alerts").notNull().default(true),
    showOnPages: boolean("show_on_pages").notNull().default(true),
    /* In effect when the sweep last looked. */
    active: boolean("active").notNull().default(false),
    /* Set once no occurrence is left; finished windows are skipped by the sweep. */
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("maintenance_windows_workspace_idx").on(t.workspaceId),
    index("maintenance_windows_unfinished_idx").on(t.finishedAt),
  ],
);

export type MaintenanceWindowRow = typeof maintenanceWindows.$inferSelect;
