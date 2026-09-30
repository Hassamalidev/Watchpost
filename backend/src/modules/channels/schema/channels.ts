/*
 * Tables owned by the channels module (PRODUCT.md §7.4, §8). Channel configs hold secrets (webhook
 * URLs, bot tokens), so they are stored encrypted with AAD `channel:<id>`. message_refs remember the
 * provider message for an incident so follow-ups thread and update it (§9.4).
 */
import type { ChannelStatus, ChannelType } from "@app/shared";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organization } from "../../../infra/auth/schema.js";

export const channels = pgTable(
  "channels",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    type: text("type").$type<ChannelType>().notNull(),
    name: text("name").notNull(),
    configEnc: text("config_enc").notNull(),
    status: text("status").$type<ChannelStatus>().notNull().default("healthy"),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    lastError: text("last_error"),
    /* Failed deliveries since the last success. */
    failureCount: integer("failure_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("channels_workspace_idx").on(t.workspaceId)],
);

export const messageRefs = pgTable(
  "message_refs",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    incidentId: uuid("incident_id").notNull(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    providerRef: text("provider_ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("message_refs_incident_channel_uq").on(t.incidentId, t.channelId)],
);

export type ChannelRow = typeof channels.$inferSelect;
