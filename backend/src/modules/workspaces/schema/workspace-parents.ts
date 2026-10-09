/*
 * Agency client workspaces (PRODUCT.md §4 "Built for agencies", §5): a client workspace points at
 * the agency workspace that owns it. One level only: a client can't have clients.
 */
import { index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "../../../infra/auth/schema.js";

export const workspaceParents = pgTable(
  "workspace_parents",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workspace_parents_parent_idx").on(t.parentId)],
);
