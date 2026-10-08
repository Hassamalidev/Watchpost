/*
 * The public API, `/api/v1` (PRODUCT.md §6.13, §7.9): API keys with their scopes, and the shapes v1
 * answers with. v1 is a promise to people's scripts, so its answers are written down here on their
 * own and don't follow the web app's internal views; the OpenAPI document is generated from these.
 */
import { z } from "zod";
import { MONITOR_TYPES } from "./monitors.js";
import { maintenanceScopeSchema } from "./maintenance.js";

/* What a key may do. A write scope includes reading the same thing. */
export const API_SCOPES = [
  "monitors:read",
  "monitors:write",
  "incidents:read",
  "incidents:write",
  "maintenance:read",
  "maintenance:write",
  "status_pages:read",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const isWriteScope = (scope: ApiScope) => scope.endsWith(":write");

/* True when a key holding `held` may use a route that needs `needed`. */
export function scopeAllows(held: readonly string[], needed: ApiScope): boolean {
  if (held.includes(needed)) return true;
  return needed.endsWith(":read") && held.includes(needed.replace(/:read$/, ":write"));
}

export const API_KEY_PREFIX = "wp";
export const API_KEYS_PER_WORKSPACE = 25;
/* Requests one key may make per minute. */
export const API_RATE_LIMIT_PER_MINUTE = 120;
export const IDEMPOTENCY_KEY_HOURS = 24;

export const createApiKeySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: z
      .array(z.enum(API_SCOPES))
      .min(1)
      .transform((list) => [...new Set(list)]),
    /* Null for a key that doesn't expire. */
    expiresInDays: z.number().int().min(1).max(365).nullable().default(null),
  })
  .strict();
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

export interface ApiKeyView {
  id: string;
  name: string;
  /* The start of the key, enough to tell keys apart; the rest is never shown again. */
  prefix: string;
  scopes: ApiScope[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

/* The answer to creating a key: the only time the whole key is shown. */
export interface CreatedApiKey extends ApiKeyView {
  key: string;
}

/* ---- v1 resources ---- */

const timestamp = z.iso.datetime().describe("ISO 8601, UTC");
const page = <T extends z.ZodType>(item: T) =>
  z.object({
    data: z.array(item),
    nextCursor: z
      .string()
      .nullable()
      .describe("Pass as `cursor` to get the next page; null on the last page"),
  });

export const v1MonitorSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  type: z.enum(MONITOR_TYPES),
  config: z
    .record(z.string(), z.unknown())
    .describe("What is checked. Its fields depend on `type`; secrets are never returned"),
  intervalSeconds: z.number().int(),
  timeoutMs: z.number().int(),
  regions: z.array(z.string()),
  tags: z.array(z.string()),
  groupId: z.uuid().nullable(),
  severity: z.enum(["critical", "high", "low"]),
  paused: z.boolean(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type V1Monitor = z.infer<typeof v1MonitorSchema>;
export const v1MonitorPageSchema = page(v1MonitorSchema);

export const v1IncidentSchema = z.object({
  id: z.uuid(),
  number: z.number().int().describe("The incident's number in the workspace (#12)"),
  title: z.string(),
  status: z.enum(["triggered", "acknowledged", "snoozed", "resolved"]),
  severity: z.enum(["critical", "high", "low"]),
  source: z
    .string()
    .describe("What opened it: monitor, heartbeat, inbound, manual, expiry or drill"),
  monitorId: z.uuid().nullable(),
  causeCode: z.string().nullable(),
  failingRegions: z.array(z.string()),
  startedAt: timestamp,
  acknowledgedAt: timestamp.nullable(),
  resolvedAt: timestamp.nullable(),
  durationSeconds: z.number(),
});
export type V1Incident = z.infer<typeof v1IncidentSchema>;
export const v1IncidentPageSchema = page(v1IncidentSchema);

export const v1MaintenanceWindowSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  startsAt: timestamp,
  endsAt: timestamp,
  timezone: z.string(),
  rrule: z.string().nullable(),
  scope: maintenanceScopeSchema,
  suppressAlerts: z.boolean(),
  showOnPages: z.boolean(),
  active: z.boolean().describe("In effect right now"),
  nextStart: timestamp.nullable(),
});
export type V1MaintenanceWindow = z.infer<typeof v1MaintenanceWindowSchema>;
export const v1MaintenanceListSchema = z.object({ data: z.array(v1MaintenanceWindowSchema) });

export const v1StatusPageSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  url: z.string(),
  published: z.boolean(),
  components: z.array(z.object({ id: z.uuid(), name: z.string(), monitorId: z.uuid().nullable() })),
});
export type V1StatusPage = z.infer<typeof v1StatusPageSchema>;
export const v1StatusPageListSchema = z.object({ data: z.array(v1StatusPageSchema) });

/* `GET /api/v1/me`: what the key in use is and may do. */
export const v1KeyInfoSchema = z.object({
  workspaceId: z.uuid(),
  workspaceName: z.string(),
  keyName: z.string(),
  scopes: z.array(z.enum(API_SCOPES)),
  expiresAt: timestamp.nullable(),
});
export type V1KeyInfo = z.infer<typeof v1KeyInfoSchema>;
