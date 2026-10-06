/* Tables owned by the reports module (PRODUCT.md §7.4): which weekly digests went out. */
import { pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";

export const digestSends = pgTable(
  "digest_sends",
  {
    workspaceId: uuid("workspace_id").notNull(),
    /* Monday 00:00 UTC of the week the digest covers. */
    weekStart: timestamp("week_start", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.weekStart] })],
);
