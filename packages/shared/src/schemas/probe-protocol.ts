/*
 * Probe ↔ API protocol (PRODUCT.md §7.6). All calls go to /api/probe/v1 and are signed:
 *   X-Probe-Signature = hex(HMAC_SHA256(secret, ts + "\n" + method + "\n" + path + "\n" + sha256hex(body)))
 * Requests more than 60 s off the server clock are rejected.
 */
import { z } from "zod";
import { REGIONS } from "../constants/regions.js";
import { monitorConfigSchema } from "./monitors.js";
import { checkResultSchema } from "./results.js";

export const PROBE_API_PREFIX = "/api/probe/v1";
export const PROBE_HEADERS = {
  id: "x-probe-id",
  timestamp: "x-probe-timestamp",
  signature: "x-probe-signature",
} as const;
export const PROBE_MAX_CLOCK_SKEW_SECONDS = 60;
export const PROBE_MAX_BATCH_RESULTS = 500;

/* The exact string a probe signs; the API rebuilds it to verify. */
export function probeSigningString(input: {
  timestamp: string | number;
  method: string;
  path: string;
  bodySha256Hex: string;
}): string {
  return `${input.timestamp}\n${input.method.toUpperCase()}\n${input.path}\n${input.bodySha256Hex}`;
}

export const PROBE_CAPABILITIES = ["http", "tcp", "dns", "ping", "websocket", "tls"] as const;

export const helloRequestSchema = z.object({
  version: z.string().min(1).max(64),
  mode: z.enum(["managed", "private"]),
  region: z.enum(REGIONS),
  capabilities: z.array(z.enum(PROBE_CAPABILITIES)).max(PROBE_CAPABILITIES.length),
});

export const helloResponseSchema = z.object({
  probeId: z.uuid(),
  serverTime: z.iso.datetime({ offset: true }),
  syncIntervalMs: z.number().int().min(1_000),
  batch: z.object({
    maxResults: z.number().int().min(1).max(PROBE_MAX_BATCH_RESULTS),
    maxWaitMs: z.number().int().min(100),
  }),
});

/* A monitor as a probe needs it: config plus timing; secrets arrive decrypted over TLS. */
export const assignedMonitorSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  config: monitorConfigSchema,
  intervalSeconds: z.number().int().min(15),
  timeoutMs: z.number().int().min(1_000).max(30_000),
  /* Bumped on every change, so probes can ignore stale updates. */
  configSeq: z.number().int().min(0),
});

export const assignmentsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  full: z.coerce.boolean().default(false),
});

export const assignmentsResponseSchema = z.object({
  /* Global change sequence to pass as `after` next time. */
  cursor: z.number().int().min(0),
  /* True when this is a full snapshot: the probe replaces everything it has. */
  full: z.boolean(),
  upserts: z.array(assignedMonitorSchema),
  deletes: z.array(z.uuid()),
});

export const resultsBatchSchema = z.object({
  batchId: z.uuid(),
  results: z.array(checkResultSchema).min(1).max(PROBE_MAX_BATCH_RESULTS),
});

export const resultsAcceptedSchema = z.object({
  accepted: z.number().int().min(0),
  duplicates: z.number().int().min(0),
});

export const probeTaskSchema = z.object({
  id: z.uuid(),
  kind: z.enum(["verify", "test"]),
  monitor: assignedMonitorSchema,
  /* The probe drops a task it can't start before this time. */
  deadline: z.iso.datetime({ offset: true }),
});

export const tasksQuerySchema = z.object({
  wait: z.coerce.number().int().min(0).max(30).default(25),
});

export const tasksResponseSchema = z.object({ tasks: z.array(probeTaskSchema) });

export const probeHeartbeatSchema = z.object({
  version: z.string().min(1).max(64),
  uptimeSeconds: z.number().int().min(0),
  assigned: z.number().int().min(0),
  inFlight: z.number().int().min(0),
  queueDepth: z.number().int().min(0),
  bufferedResults: z.number().int().min(0),
  loadAverage: z.number().min(0).optional(),
  errors: z.record(z.string(), z.number().int().min(0)).default({}),
});

export type HelloRequest = z.infer<typeof helloRequestSchema>;
export type HelloResponse = z.infer<typeof helloResponseSchema>;
export type AssignedMonitor = z.infer<typeof assignedMonitorSchema>;
export type AssignmentsResponse = z.infer<typeof assignmentsResponseSchema>;
export type ResultsBatch = z.infer<typeof resultsBatchSchema>;
export type ProbeTask = z.infer<typeof probeTaskSchema>;
export type ProbeHeartbeat = z.infer<typeof probeHeartbeatSchema>;
