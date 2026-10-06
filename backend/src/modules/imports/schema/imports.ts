/*
 * Tables owned by the imports module (PRODUCT.md §7.4, §8). One row per applied import: where it
 * came from and what became of each object. The other tool's export itself is not kept.
 */
import type { ImportItemView, ImportSource } from "@app/shared";
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "../../../infra/auth/schema.js";

export const imports = pgTable(
  "imports",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    source: text("source").$type<ImportSource>().notNull(),
    items: jsonb("items").$type<ImportItemView[]>().notNull(),
    total: integer("total").notNull(),
    mapped: integer("mapped").notNull(),
    created: integer("created").notNull(),
    failed: integer("failed").notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("imports_workspace_idx").on(t.workspaceId, t.createdAt)],
);

export type ImportRow = typeof imports.$inferSelect;
