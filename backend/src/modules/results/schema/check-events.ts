/*
 * check_events (PRODUCT.md §7.7, §8): failures and state changes, kept for the plan's history period
 * (raw results live only 48 h). One row per failed result (same id) or per state change.
 */
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const checkEvents = pgTable(
  "check_events",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    monitorId: uuid("monitor_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    kind: text("kind").$type<"failure" | "state_change">().notNull(),
    region: text("region"),
    errorCode: text("error_code"),
    httpStatus: integer("http_status"),
    message: text("message"),
    details: jsonb("details").$type<Record<string, unknown>>(),
  },
  (t) => [
    index("check_events_monitor_at_idx").on(t.monitorId, t.at.desc()),
    index("check_events_workspace_at_idx").on(t.workspaceId, t.at.desc()),
  ],
);

export type CheckEventRow = typeof checkEvents.$inferSelect;
