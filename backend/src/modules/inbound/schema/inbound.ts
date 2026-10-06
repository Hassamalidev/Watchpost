/*
 * Tables owned by the inbound module (PRODUCT.md §7.4, §8). A source is one token URL another tool
 * posts its alerts to; the token is stored hashed and shown once.
 */
import type { InboundKind } from "@app/shared";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organization } from "../../../infra/auth/schema.js";

export const inboundSources = pgTable(
  "inbound_sources",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").$type<InboundKind>().notNull(),
    tokenHash: text("token_hash").notNull(),
    /* The first characters of the token, to tell sources apart in the list. */
    tokenHint: text("token_hint").notNull(),
    lastReceivedAt: timestamp("last_received_at", { withTimezone: true }),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("inbound_sources_token_uq").on(t.tokenHash),
    index("inbound_sources_workspace_idx").on(t.workspaceId),
  ],
);

export type InboundSourceRow = typeof inboundSources.$inferSelect;
