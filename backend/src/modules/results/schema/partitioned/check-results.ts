/*
 * check_results: raw check results, partitioned by day on checked_at (PRODUCT.md §7.7, §8).
 * Drizzle can't create partitioned tables, so this definition is for queries only; it lives outside
 * drizzle-kit's schema glob and the table itself comes from a custom migration (0005).
 * Primary key (checked_at, id) makes inserts idempotent (ON CONFLICT DO NOTHING).
 */
import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { CheckResult } from "@app/shared";

export const checkResults = pgTable("check_results", {
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
  id: uuid("id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  monitorId: uuid("monitor_id").notNull(),
  region: text("region").notNull(),
  probeId: uuid("probe_id"),
  ok: boolean("ok").notNull(),
  errorCode: text("error_code"),
  message: text("message"),
  httpStatus: integer("http_status"),
  latencyMs: integer("latency_ms").notNull(),
  timings: jsonb("timings").$type<NonNullable<CheckResult["timings"]>>(),
  ip: text("ip"),
  tls: jsonb("tls").$type<NonNullable<CheckResult["tls"]>>(),
  details: jsonb("details").$type<Record<string, unknown>>(),
  taskId: uuid("task_id"),
  evidenceKey: text("evidence_key"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CheckResultRow = typeof checkResults.$inferSelect;
