/*
 * Table owned by the audit module (PRODUCT.md §7.4, §8): one row per change made in a workspace.
 * Append-only: nothing updates a row, and only the retention sweep deletes.
 */
import type { AuditActorType, AuditCategory } from "@app/shared";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "../../../infra/auth/schema.js";

export const auditLogs = pgTable(
  "audit_logs",
  {
    /* UUIDv7: sorts by time, so it is also the paging cursor. */
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull(),
    category: text("category").$type<AuditCategory>().notNull(),
    action: text("action").notNull(),
    actorType: text("actor_type").$type<AuditActorType>().notNull(),
    /* The user or API key; null for the system. Kept as it was, also after they are deleted. */
    actorId: uuid("actor_id"),
    /* Who that was in words at the time (an email address, a key's name). */
    actorLabel: text("actor_label").notNull(),
    targetId: text("target_id"),
    detail: text("detail"),
    ip: text("ip"),
  },
  (t) => [
    index("audit_logs_workspace_idx").on(t.workspaceId, t.id.desc()),
    index("audit_logs_at_idx").on(t.at),
  ],
);
