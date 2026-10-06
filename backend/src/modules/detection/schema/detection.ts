/*
 * Tables owned by the detection module (PRODUCT.md §8, §9.2). monitor_state is the source of truth for
 * a monitor's status and is locked (FOR UPDATE) during evaluation; monitor_region_state is only a
 * cache for the UI; downtimes hold exact outage intervals for uptime math (§9.9).
 */
import { MONITOR_STATUSES, type MonitorStatus } from "@app/shared";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export type DowntimeKind = "outage" | "degraded" | "maintenance";
export type RegionStatus = "up" | "down" | "degraded" | "unknown";

export const monitorState = pgTable(
  "monitor_state",
  {
    monitorId: uuid("monitor_id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    status: text("status", { enum: MONITOR_STATUSES })
      .$type<MonitorStatus>()
      .notNull()
      .default("pending"),
    since: timestamp("since", { withTimezone: true }).notNull().defaultNow(),
    /* Human-readable reason for the status ("Regional issue: ap-southeast only"). */
    reason: text("reason"),
    openIncidentId: uuid("open_incident_id"),
    lastResultAt: timestamp("last_result_at", { withTimezone: true }),
    /* The last_result_at seen by the last evaluation; the recovery sweep compares the two. */
    lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }),
    /* Set while a verification round is in flight. */
    verifyRequestedAt: timestamp("verify_requested_at", { withTimezone: true }),
    /* Up/down changes in the last 30 minutes, for flap detection. */
    stateChanges: timestamp("state_changes", { withTimezone: true })
      .array()
      .notNull()
      .default(sql`'{}'::timestamptz[]`),
    flappingUntil: timestamp("flapping_until", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("monitor_state_workspace_idx").on(t.workspaceId),
    index("monitor_state_unevaluated_idx")
      .on(t.monitorId)
      .where(sql`${t.lastResultAt} > coalesce(${t.lastEvaluatedAt}, '-infinity'::timestamptz)`),
  ],
);

export const monitorRegionState = pgTable(
  "monitor_region_state",
  {
    monitorId: uuid("monitor_id").notNull(),
    region: text("region").notNull(),
    status: text("status").$type<RegionStatus>().notNull(),
    lastResultAt: timestamp("last_result_at", { withTimezone: true }).notNull(),
    lastErrorCode: text("last_error_code"),
    lastLatencyMs: integer("last_latency_ms"),
  },
  (t) => [primaryKey({ columns: [t.monitorId, t.region] })],
);

export const downtimes = pgTable(
  "downtimes",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    monitorId: uuid("monitor_id").notNull(),
    kind: text("kind").$type<DowntimeKind>().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    incidentId: uuid("incident_id"),
  },
  (t) => [
    index("downtimes_monitor_started_idx").on(t.monitorId, t.startedAt.desc()),
    uniqueIndex("downtimes_one_open_per_monitor_uq")
      .on(t.monitorId)
      .where(sql`${t.endedAt} is null`),
  ],
);

export type MonitorStateRow = typeof monitorState.$inferSelect;
export type DowntimeRow = typeof downtimes.$inferSelect;
