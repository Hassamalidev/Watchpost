/*
 * Workspace deletion (PRODUCT.md §13 "Privacy"): a request waits 30 days, in which the owner can
 * cancel it, and then the workspace is erased. `workspace_erasures` keeps the one fact that it was:
 * its column is deliberately not called workspace_id, which is what erasure looks for.
 */
import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "../../../infra/auth/schema.js";

export const workspaceDeletions = pgTable(
  "workspace_deletions",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    /* The email address of the owner who asked. */
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    deleteAfter: timestamp("delete_after", { withTimezone: true }).notNull(),
  },
  (t) => [index("workspace_deletions_due_idx").on(t.deleteAfter)],
);

export const workspaceErasures = pgTable("workspace_erasures", {
  erasedWorkspaceId: uuid("erased_workspace_id").primaryKey(),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
  erasedAt: timestamp("erased_at", { withTimezone: true }).notNull(),
  /* Evidence objects removed from storage. */
  objects: integer("objects").notNull().default(0),
});

export type WorkspaceDeletionRow = typeof workspaceDeletions.$inferSelect;
