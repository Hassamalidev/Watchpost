/*
 * Tables owned by the probes module (PRODUCT.md §7.4, §8): the probe registry and on-demand tasks
 * (cross-region verification and "Test now").
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "../../../infra/auth/schema.js";

export const probes = pgTable("probes", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  region: text("region").notNull(),
  kind: text("kind").$type<"managed" | "private">().notNull(),
  /* Null for managed probes; private probes belong to one workspace. */
  workspaceId: uuid("workspace_id").references(() => organization.id, { onDelete: "cascade" }),
  /* HMAC secret, AES-GCM-encrypted with AAD probe:<id> (the server needs the raw secret, §7.6). */
  secretEnc: text("secret_enc").notNull(),
  disabled: boolean("disabled").notNull().default(false),
  version: text("version"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  lastHeartbeat: jsonb("last_heartbeat").$type<Record<string, unknown>>(),
  /* Probe health guard (§9.2, P2-T03): failures from a quarantined probe don't count. */
  quarantinedUntil: timestamp("quarantined_until", { withTimezone: true }),
  /* Private probes: when its workspace was told it went silent; cleared when it reports again. */
  offlineNotifiedAt: timestamp("offline_notified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const probeTasks = pgTable(
  "probe_tasks",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    monitorId: uuid("monitor_id").notNull(),
    region: text("region").notNull(),
    kind: text("kind").$type<"verify" | "test">().notNull(),
    /* Dedupe key per monitor/region/kind/window (§9.2: one verification per window). */
    dedupeKey: text("dedupe_key").notNull(),
    claimedBy: uuid("claimed_by"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    resultId: uuid("result_id"),
    /* The check result for "Test now", so the UI can show it without scanning result partitions. */
    result: jsonb("result").$type<Record<string, unknown>>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("probe_tasks_dedupe_uq").on(t.dedupeKey),
    index("probe_tasks_pending_idx")
      .on(t.region, t.createdAt)
      .where(sql`${t.claimedBy} is null`),
  ],
);

export type ProbeRow = typeof probes.$inferSelect;
export type ProbeTaskRow = typeof probeTasks.$inferSelect;
