/* Product-wide constants. */
export const PRODUCT_NAME = "Watchpost";

/* Monitor states from the detection state machine (PRODUCT.md §9.2). */
export const MONITOR_STATUSES = [
  "pending",
  "up",
  "verifying",
  "degraded",
  "down",
  "maintenance",
  "paused",
] as const;

export type MonitorStatus = (typeof MONITOR_STATUSES)[number];
