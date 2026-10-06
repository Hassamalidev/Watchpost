/*
 * Tables owned by the contacts module (PRODUCT.md §7.4, §8). A contact method belongs to one user in
 * one workspace and is used only after its owner proved it is theirs with a one-time code (the code
 * is stored hashed). A notification rule says how long after an incident reaches the user a method
 * is tried, per urgency.
 */
import type { ContactMethodType, Urgency } from "@app/shared";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organization } from "../../../infra/auth/schema.js";

export const contactMethods = pgTable(
  "contact_methods",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    type: text("type").$type<ContactMethodType>().notNull(),
    /* Lower-case email, or an E.164 phone number. */
    address: text("address").notNull(),
    label: text("label"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    codeHash: text("code_hash"),
    codeExpiresAt: timestamp("code_expires_at", { withTimezone: true }),
    /* Wrong guesses at the current code. */
    codeAttempts: integer("code_attempts").notNull().default(0),
    /* Codes sent in the hour starting at `code_window_start`. */
    codeSendCount: integer("code_send_count").notNull().default(0),
    codeWindowStart: timestamp("code_window_start", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("contact_methods_user_address_uq").on(t.workspaceId, t.userId, t.type, t.address),
    index("contact_methods_user_idx").on(t.workspaceId, t.userId),
  ],
);

export const notificationRules = pgTable(
  "notification_rules",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    urgency: text("urgency").$type<Urgency>().notNull(),
    delayMinutes: integer("delay_minutes").notNull().default(0),
    contactMethodId: uuid("contact_method_id")
      .notNull()
      .references(() => contactMethods.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("notification_rules_method_uq").on(
      t.workspaceId,
      t.userId,
      t.urgency,
      t.contactMethodId,
    ),
  ],
);

/* A chat app user (a Slack member, a Telegram account) tied to a member of the workspace. */
export const chatLinks = pgTable(
  "chat_links",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    provider: text("provider").$type<"slack" | "telegram">().notNull(),
    externalId: text("external_id").notNull(),
    externalName: text("external_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("chat_links_external_uq").on(t.workspaceId, t.provider, t.externalId),
    index("chat_links_user_idx").on(t.workspaceId, t.userId),
  ],
);

export type ChatLinkRow = typeof chatLinks.$inferSelect;
export type ContactMethodRow = typeof contactMethods.$inferSelect;
export type NotificationRuleRow = typeof notificationRules.$inferSelect;
