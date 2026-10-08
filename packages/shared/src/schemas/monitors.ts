/*
 * Monitor configuration (PRODUCT.md §6.1–6.2). `monitorConfigSchema` is a discriminated union on
 * `type` for the Phase 1 monitor types; `monitorSettingsSchema` holds the options every monitor has.
 * The API validates with these; probes receive the same shapes in assignments.
 */
import { z } from "zod";
import { REGIONS, SEVERITIES, isPrivateRegion } from "../constants/regions.js";
import { checkRegionSchema } from "./region.js";

export const MONITOR_TYPES = [
  "http",
  "keyword",
  "json_query",
  "tcp",
  "ping",
  "dns",
  "websocket",
  "ssl",
  "domain",
  "heartbeat",
  /* Protocol checks for services inside a network: private probes only (§6.1). */
  "redis",
  "mqtt",
  "grpc",
] as const;
export type MonitorType = (typeof MONITOR_TYPES)[number];

/* Types that run on a private probe and nowhere else. */
export const PRIVATE_PROBE_MONITOR_TYPES: readonly MonitorType[] = ["redis", "mqtt", "grpc"];

/* Hostname (RFC 1123 labels) or an IPv4/IPv6 literal. */
const HOSTNAME = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*\.?$/i;
const host = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine(
    (v) => HOSTNAME.test(v) || z.ipv4().safeParse(v).success || z.ipv6().safeParse(v).success,
    "must be a hostname or IP address",
  );
const port = z.number().int().min(1).max(65_535);

const httpUrl = z
  .url({ protocol: /^https?$/ })
  .max(2_048)
  .describe("http:// or https:// URL");
const wsUrl = z
  .url({ protocol: /^wss?$/ })
  .max(2_048)
  .describe("ws:// or wss:// URL");

const header = z.object({
  name: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "must be a valid header name"),
  value: z.string().max(8_192),
});

/* "200", "200-299" or "3xx"-style shorthand is kept simple: single codes and inclusive ranges. */
const statusRange = z
  .string()
  .regex(/^[1-5]\d\d(-[1-5]\d\d)?$/, 'must look like "200" or "200-299"')
  .refine((v) => {
    const [from, to] = v.split("-").map(Number);
    return to === undefined || (from ?? 0) <= to;
  }, "range start must not exceed its end");

const httpAuth = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("basic"),
    username: z.string().min(1).max(256),
    password: z.string().max(1_024),
  }),
  z.object({ kind: z.literal("bearer"), token: z.string().min(1).max(4_096) }),
]);

const httpRequest = {
  url: httpUrl,
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).default("GET"),
  headers: z.array(header).max(50).default([]),
  body: z.string().max(65_536).optional(),
  auth: httpAuth.default({ kind: "none" }),
  acceptedStatusCodes: z.array(statusRange).min(1).max(20).default(["200-299"]),
  followRedirects: z.boolean().default(true),
  ignoreTlsErrors: z.boolean().default(false),
};

export const httpConfigSchema = z.object({ type: z.literal("http"), ...httpRequest });

export const keywordConfigSchema = z.object({
  type: z.literal("keyword"),
  ...httpRequest,
  keyword: z.string().min(1).max(1_024),
  mode: z.enum(["contains", "not_contains"]).default("contains"),
  caseSensitive: z.boolean().default(false),
  isRegex: z.boolean().default(false),
});

export const JSON_QUERY_OPERATORS = ["==", "!=", "<", ">", "contains", "matches"] as const;

export const jsonQueryConfigSchema = z.object({
  type: z.literal("json_query"),
  ...httpRequest,
  /* JSONata expression evaluated against the parsed body. */
  expression: z.string().min(1).max(2_048),
  operator: z.enum(JSON_QUERY_OPERATORS),
  expected: z.string().max(1_024),
});

export const tcpConfigSchema = z.object({
  type: z.literal("tcp"),
  host,
  port,
  tls: z.boolean().default(false),
  send: z.string().max(4_096).optional(),
  expect: z.string().max(4_096).optional(),
});

export const pingConfigSchema = z.object({
  type: z.literal("ping"),
  host,
  count: z.number().int().min(1).max(10).default(3),
  /* Percentage of lost packets that still counts as up. */
  maxLossPercent: z.number().min(0).max(100).default(0),
});

export const DNS_RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA", "CAA"] as const;

export const dnsConfigSchema = z.object({
  type: z.literal("dns"),
  hostname: host,
  recordType: z.enum(DNS_RECORD_TYPES),
  /* Resolver IP; the probe's default resolver when omitted. */
  resolver: z.union([z.ipv4(), z.ipv6()]).optional(),
  /* When set, the answer must contain every value. */
  expectedValues: z.array(z.string().min(1).max(1_024)).max(50).default([]),
  /* Record an event when the answer changes, even if it still matches. */
  alertOnChange: z.boolean().default(false),
});

export const websocketConfigSchema = z.object({
  type: z.literal("websocket"),
  url: wsUrl,
  subprotocols: z.array(z.string().min(1).max(128)).max(10).default([]),
  headers: z.array(header).max(50).default([]),
  send: z.string().max(4_096).optional(),
  expect: z.string().max(4_096).optional(),
});

const warnDays = (defaults: number[]) =>
  z.array(z.number().int().min(1).max(365)).min(1).max(10).default(defaults);

export const sslConfigSchema = z.object({
  type: z.literal("ssl"),
  host,
  port: port.default(443),
  warnDays: warnDays([30, 14, 7, 3, 1]),
});

export const domainConfigSchema = z.object({
  type: z.literal("domain"),
  domain: host,
  warnDays: warnDays([60, 30, 14, 7, 1]),
});

export const heartbeatScheduleSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("period"),
    periodSeconds: z
      .number()
      .int()
      .min(30)
      .max(31 * 86_400),
  }),
  z.object({
    kind: z.literal("cron"),
    /* Five-field cron expression; validated fully by the API with cron-parser. */
    expression: z
      .string()
      .trim()
      .regex(/^(\S+\s+){4}\S+$/, "must be a five-field cron expression"),
    timezone: z.string().min(1).max(64).default("UTC"),
  }),
]);

export const heartbeatConfigSchema = z.object({
  type: z.literal("heartbeat"),
  schedule: heartbeatScheduleSchema,
  graceSeconds: z.number().int().min(0).max(86_400).default(300),
  /* A run longer than this is degraded (needs /start and a finish ping). */
  maxDurationSeconds: z
    .number()
    .int()
    .min(1)
    .max(7 * 86_400)
    .optional(),
});

/* A login for a service; the password is stored encrypted and never returned. */
const credentials = {
  username: z.string().min(1).max(256).optional(),
  password: z.string().min(1).max(1_024).optional(),
};

/* Redis (and what speaks its protocol: Valkey, KeyDB, Dragonfly): answers PING after an optional login. */
export const redisConfigSchema = z.object({
  type: z.literal("redis"),
  host,
  port: port.default(6379),
  tls: z.boolean().default(false),
  ...credentials,
});

/* An MQTT broker accepts a connection (protocol 3.1.1), with a login when given. */
export const mqttConfigSchema = z.object({
  type: z.literal("mqtt"),
  host,
  port: port.default(1883),
  tls: z.boolean().default(false),
  ...credentials,
  clientId: z
    .string()
    .regex(/^[0-9A-Za-z_-]{1,23}$/, "1 to 23 letters, digits, - or _")
    .optional(),
});

/* A gRPC server reports SERVING on the standard health service (grpc.health.v1.Health). */
export const grpcConfigSchema = z.object({
  type: z.literal("grpc"),
  host,
  port,
  tls: z.boolean().default(true),
  /* The service to ask about; empty asks about the server as a whole. */
  service: z.string().max(100).default(""),
});

export const monitorConfigSchema = z.discriminatedUnion("type", [
  httpConfigSchema,
  keywordConfigSchema,
  jsonQueryConfigSchema,
  tcpConfigSchema,
  pingConfigSchema,
  dnsConfigSchema,
  websocketConfigSchema,
  sslConfigSchema,
  domainConfigSchema,
  heartbeatConfigSchema,
  redisConfigSchema,
  mqttConfigSchema,
  grpcConfigSchema,
]);

export type MonitorConfig = z.infer<typeof monitorConfigSchema>;
export type MonitorConfigInput = z.input<typeof monitorConfigSchema>;

/* Options every monitor has (§6.2). Plan limits (interval, regions) are enforced by the API. */
/* The plain object, for partial updates; use monitorSettingsSchema to validate complete settings. */
export const monitorSettingsObject = z.object({
  name: z.string().trim().min(1).max(200),
  intervalSeconds: z.number().int().min(15).max(86_400).default(300),
  timeoutMs: z.number().int().min(1_000).max(30_000).default(10_000),
  regions: z.array(checkRegionSchema).min(1).max(REGIONS.length).default(["eu-central", "us-east"]),
  /* Failing regions needed before an incident opens (default 2; 1 in single-region setups). */
  minFailingRegions: z.number().int().min(1).max(REGIONS.length).default(2),
  /*
   * A failure confirmed in fewer regions than that is a regional issue: shown as degraded, and
   * alerted (as a low-severity incident) only when this is on.
   */
  alertOnRegionalIssue: z.boolean().default(false),
  /* Consecutive successes needed to recover; 0 means "pick by interval" (§6.2). */
  recoverySuccesses: z.number().int().min(0).max(10).default(0),
  degradedLatencyMs: z.number().int().min(1).max(60_000).optional(),
  degradedAfterChecks: z.number().int().min(1).max(20).default(3),
  upsideDown: z.boolean().default(false),
  /* Monthly availability objective; the error budget is the downtime it allows. */
  sloTarget: z.number().min(90).max(99.999).default(99.9),
  /* Re-notify channels every N minutes while down; off when omitted. */
  reminderMinutes: z.number().int().min(5).max(1_440).optional(),
  severity: z.enum(SEVERITIES).default("high"),
  tags: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
  groupId: z.uuid().optional(),
  parentId: z.uuid().optional(),
  alertPolicyId: z.uuid().optional(),
  runbookUrl: z.url().max(2_048).optional(),
  notes: z.string().max(10_000).optional(),
  publicName: z.string().trim().max(200).optional(),
});

export const monitorSettingsSchema = monitorSettingsObject
  .refine((s) => s.timeoutMs < s.intervalSeconds * 1_000, {
    message: "timeout must be shorter than the interval",
    path: ["timeoutMs"],
  })
  .refine((s) => new Set(s.regions).size === s.regions.length, {
    message: "regions must not repeat",
    path: ["regions"],
  })
  /* What a private probe can reach, our regions usually can't: mixing them would report it down. */
  .refine((s) => s.regions.length === 1 || !s.regions.some(isPrivateRegion), {
    message: "a monitor on a private probe runs there only",
    path: ["regions"],
  });

export type MonitorSettings = z.infer<typeof monitorSettingsSchema>;

export const createMonitorSchema = z.object({
  settings: monitorSettingsSchema,
  config: monitorConfigSchema,
});

export type CreateMonitorInput = z.input<typeof createMonitorSchema>;

/* Default recovery successes when the setting is 0 (§6.2): 2 for intervals up to 60 s, else 1. */
export function effectiveRecoverySuccesses(
  settings: Pick<MonitorSettings, "recoverySuccesses" | "intervalSeconds">,
): number {
  if (settings.recoverySuccesses > 0) return settings.recoverySuccesses;
  return settings.intervalSeconds <= 60 ? 2 : 1;
}

/* Parses "200-299"-style ranges and checks a status code against them. */
export function isAcceptedStatus(status: number, ranges: readonly string[]): boolean {
  return ranges.some((range) => {
    const [from, to] = range.split("-").map(Number);
    if (from === undefined || Number.isNaN(from)) return false;
    return to === undefined ? status === from : status >= from && status <= to;
  });
}

/* Monitor types that probes execute (the rest are driven by the API: heartbeats, domain expiry). */
export const PROBE_MONITOR_TYPES: readonly MonitorType[] = [
  "http",
  "keyword",
  "json_query",
  "tcp",
  "ping",
  "dns",
  "websocket",
  "ssl",
  "redis",
  "mqtt",
  "grpc",
];
