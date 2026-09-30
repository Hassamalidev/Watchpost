/*
 * Latency and availability rollups (PRODUCT.md §7.7, §9.9): one row per monitor, region and bucket
 * (5 minutes, 1 hour, 1 day). Latency figures cover successful checks; `histogram` holds counts per
 * fixed log-scale bucket (histogram.ts), so larger rollups are element-wise sums. Retention: 5-minute
 * rows 90 days, hourly 25 months, daily forever.
 */
import {
  bigint,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/* Every rollup table has the same columns; names stay literal so table ownership stays checkable. */
const columns = () => ({
  monitorId: uuid("monitor_id").notNull(),
  region: text("region").notNull(),
  bucket: timestamp("bucket", { withTimezone: true }).notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  count: integer("count").notNull(),
  failCount: integer("fail_count").notNull(),
  okCount: integer("ok_count").notNull(),
  latencySum: bigint("latency_sum", { mode: "number" }).notNull(),
  latencyMin: integer("latency_min"),
  latencyMax: integer("latency_max"),
  histogram: integer("histogram").array().notNull(),
});

type RollupColumns = ReturnType<typeof columns>;
const keys = (name: string) => (t: { [K in keyof RollupColumns]: AnyPgColumn }) => [
  primaryKey({ columns: [t.monitorId, t.region, t.bucket] }),
  index(`${name}_bucket_idx`).on(t.bucket),
];

export const rollups5m = pgTable("rollups_5m", columns(), keys("rollups_5m"));
export const rollups1h = pgTable("rollups_1h", columns(), keys("rollups_1h"));
export const rollups1d = pgTable("rollups_1d", columns(), keys("rollups_1d"));

export type RollupRow = typeof rollups5m.$inferSelect;
