/*
 * Tables owned by the heartbeats module (PRODUCT.md §8, §9.7). heartbeat_state holds each heartbeat
 * monitor's hashed ping token, status and next deadline (a copy of the schedule, so the sweeper can
 * select overdue rows in SQL); heartbeat_pings is the ping log; platform_ticks and platform_gaps are
 * the our-outage guard.
 */
import type { HeartbeatSchedule } from "@app/shared";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export type HeartbeatStatus = "pending" | "up" | "down" | "degraded";
export type PingKind = "success" | "start" | "fail";

export const heartbeatState = pgTable(
  "heartbeat_state",
  {
    monitorId: uuid("monitor_id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    /* SHA-256 of the ping token; the token itself is shown once. */
    tokenHash: text("token_hash").notNull(),
    status: text("status").$type<HeartbeatStatus>().notNull().default("pending"),
    since: timestamp("since", { withTimezone: true }).notNull().defaultNow(),
    reason: text("reason"),
    schedule: jsonb("schedule").$type<HeartbeatSchedule>().notNull(),
    graceSeconds: integer("grace_seconds").notNull(),
    maxDurationSeconds: integer("max_duration_seconds"),
    nextExpectedAt: timestamp("next_expected_at", { withTimezone: true }),
    runningSince: timestamp("running_since", { withTimezone: true }),
    lastPingAt: timestamp("last_ping_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("heartbeat_state_token_hash_uq").on(t.tokenHash),
    index("heartbeat_state_due_idx")
      .on(t.nextExpectedAt)
      .where(sql`${t.status} in ('up', 'degraded')`),
  ],
);

export const heartbeatPings = pgTable(
  "heartbeat_pings",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    monitorId: uuid("monitor_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    kind: text("kind").$type<PingKind>().notNull(),
    exitCode: integer("exit_code"),
    durationMs: integer("duration_ms"),
    /* First 10 KB of the request body (a log tail, for example). */
    excerpt: text("excerpt"),
  },
  (t) => [index("heartbeat_pings_monitor_at_idx").on(t.monitorId, t.at.desc())],
);

/* Last "I'm alive" from each platform component ("api", "worker"). */
export const platformTicks = pgTable("platform_ticks", {
  source: text("source").primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull(),
});

/* Periods when pings could have been lost on our side; an open gap has no end yet. */
export const platformGaps = pgTable(
  "platform_gaps",
  {
    id: uuid("id").primaryKey(),
    reason: text("reason").$type<"ingest" | "worker">().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("platform_gaps_one_open_per_reason_uq")
      .on(t.reason)
      .where(sql`${t.endedAt} is null`),
    index("platform_gaps_started_idx").on(t.startedAt),
  ],
);

export type HeartbeatStateRow = typeof heartbeatState.$inferSelect;
export type HeartbeatPingRow = typeof heartbeatPings.$inferSelect;
export type PlatformGapRow = typeof platformGaps.$inferSelect;
