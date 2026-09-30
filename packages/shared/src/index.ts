/* Public entry for @app/shared: Zod schemas, types, constants and pure functions only (PRODUCT.md §7.1 rule 10). */
export { PRODUCT_NAME, MONITOR_STATUSES, type MonitorStatus } from "./constants/product.js";
export { API_ERROR_CODES, type ApiErrorCode } from "./constants/api-errors.js";
export { monitorStatusSchema } from "./schemas/monitor-status.js";
export { problemSchema, type Problem } from "./schemas/problem.js";
