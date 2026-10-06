/*
 * Tables owned by the oncall module (PRODUCT.md §7.4, §8). A schedule's layers are replaced as a set
 * when it is edited; `position` orders them, and the highest position wins where layers overlap.
 * Participants are user IDs in rotation order. Overrides put one person on call for a stretch.
 */
import type { Restriction, Rotation } from "@app/shared";
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
import { organization } from "../../../infra/auth/schema.js";

export const schedules = pgTable(
  "schedules",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /* IANA zone; handoffs and restriction windows are wall-clock times in it. */
    timezone: text("timezone").notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("schedules_workspace_idx").on(t.workspaceId)],
);

export const scheduleLayers = pgTable(
  "schedule_layers",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    scheduleId: uuid("schedule_id")
      .notNull()
      .references(() => schedules.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    name: text("name").notNull(),
    rotation: text("rotation").$type<Rotation>().notNull(),
    /* Custom rotations only. */
    shiftHours: integer("shift_hours"),
    /* The first handoff. */
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    participants: jsonb("participants").$type<string[]>().notNull(),
    restrictions: jsonb("restrictions").$type<Restriction[]>().notNull(),
  },
  (t) => [index("schedule_layers_schedule_idx").on(t.scheduleId, t.position)],
);

export const scheduleOverrides = pgTable(
  "schedule_overrides",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    scheduleId: uuid("schedule_id")
      .notNull()
      .references(() => schedules.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("schedule_overrides_schedule_idx").on(t.scheduleId, t.endsAt)],
);

/* A person's calendar feed URL: the token is stored hashed and can be replaced. */
export const oncallFeeds = pgTable(
  "oncall_feeds",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("oncall_feeds_user_uq").on(t.workspaceId, t.userId),
    uniqueIndex("oncall_feeds_token_uq").on(t.tokenHash),
  ],
);

export type OncallFeedRow = typeof oncallFeeds.$inferSelect;
export type ScheduleRow = typeof schedules.$inferSelect;
export type ScheduleLayerRow = typeof scheduleLayers.$inferSelect;
export type ScheduleOverrideRow = typeof scheduleOverrides.$inferSelect;
