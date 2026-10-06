/*
 * action_tokens (PRODUCT.md §7.4): one row per used action link. Links are signed and stateless
 * (infra/action-links.ts); recording the nonce here on first use is what makes them single-use.
 */
import { pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";

export const actionTokens = pgTable(
  "action_tokens",
  {
    nonce: text("nonce").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    incidentId: uuid("incident_id").notNull(),
    action: text("action").$type<"acknowledge" | "resolve">().notNull(),
    recipient: text("recipient").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }).notNull(),
    usedBy: uuid("used_by"),
  },
  (t) => [index("action_tokens_incident_idx").on(t.incidentId)],
);
