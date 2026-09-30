/* outbox_events: owned by infra/outbox (PRODUCT.md §7.5, §8). Timestamps come from the database clock. */
import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id"),
    type: text("type").notNull(),
    version: integer("version").notNull(),
    payload: jsonb("payload").notNull(),
    correlationId: text("correlation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
  },
  (t) => [
    index("outbox_events_undispatched_idx")
      .on(t.createdAt, t.id)
      .where(sql`${t.dispatchedAt} is null`),
    index("outbox_events_dispatched_at_idx")
      .on(t.dispatchedAt)
      .where(sql`${t.dispatchedAt} is not null`),
  ],
);

export type OutboxEventRow = typeof outboxEvents.$inferSelect;
