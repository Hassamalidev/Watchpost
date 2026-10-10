/*
 * Agency client workspaces (PRODUCT.md §4 "Built for agencies", §5): a client workspace points at
 * the agency workspace that owns it. One level only: a client can't have clients.
 */
import { index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization, user } from "../../../infra/auth/schema.js";

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

/*
 * Memberships of a client workspace that exist because the person is an owner or admin of the
 * agency. They are added and removed with that standing; a membership someone was invited into
 * is not listed here and is never touched.
 */
export const clientAdminGrants = pgTable(
  "client_admin_grants",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);
