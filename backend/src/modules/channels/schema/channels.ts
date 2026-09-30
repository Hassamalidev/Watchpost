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

/* One Slack workspace connected through OAuth; the bot token is encrypted (AAD `slack:<id>`). */
export const slackInstallations = pgTable(
  "slack_installations",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    teamId: text("team_id").notNull(),
    teamName: text("team_name").notNull(),
    botUserId: text("bot_user_id"),
    botTokenEnc: text("bot_token_enc").notNull(),
    scopes: text("scopes").notNull(),
    installedBy: uuid("installed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("slack_installations_workspace_team_uq").on(t.workspaceId, t.teamId)],
);

/* Telegram deep-link tokens and the chat each Telegram channel is linked to (§10). */
export const telegramChats = pgTable(
  "telegram_chats",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    linkToken: text("link_token"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    chatId: text("chat_id"),
    chatTitle: text("chat_title"),
    linkedAt: timestamp("linked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("telegram_chats_channel_uq").on(t.channelId),
    uniqueIndex("telegram_chats_link_token_uq").on(t.linkToken),
  ],
);

export type ChannelRow = typeof channels.$inferSelect;
export type SlackInstallationRow = typeof slackInstallations.$inferSelect;
