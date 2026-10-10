/*
 * Network diagnostics (PRODUCT.md P8-T04): when an incident opens, each failing region traces the
 * path to the target and how its name resolves, and the result goes on the incident's timeline.
 */
import { z } from "zod";
import type { MonitorConfig } from "./monitors.js";

const hopSchema = z.object({
  hop: z.number().int().min(1).max(64),
  /* Null when nothing answered at this distance. */
  ip: z.string().max(64).nullable(),
  rttMs: z.number().min(0).max(120_000).nullable(),
});

export const tracerouteSchema = z.object({
  /* The system tool that produced it. */
  tool: z.enum(["tracepath", "traceroute"]),
  hops: z.array(hopSchema).max(64),
  /* The last hop is the target itself. */
  reached: z.boolean(),
});
export type Traceroute = z.infer<typeof tracerouteSchema>;

export const DNS_TRACE_OUTCOMES = ["referral", "answer", "nxdomain", "no_data", "error"] as const;

export const dnsTraceSchema = z.object({
  name: z.string().max(253),
  /* One per zone asked, from the root down. The last one says how the trace ended. */
  steps: z
    .array(
      z.object({
        zone: z.string().max(253),
        server: z.string().max(330),
        ms: z.number().min(0).max(120_000),
        outcome: z.enum(DNS_TRACE_OUTCOMES),
        detail: z.string().max(600),
      }),
    )
    .max(12),
});
export type DnsTrace = z.infer<typeof dnsTraceSchema>;

export const networkDiagnosticsSchema = z.object({
  host: z.string().max(253),
  /* The address the path was traced to; null when the name didn't resolve. */
  address: z.string().max(64).nullable(),
  traceroute: tracerouteSchema.nullable(),
  dnsTrace: dnsTraceSchema.nullable(),
  notes: z.array(z.string().max(300)).max(6),
  tookMs: z.number().min(0).max(600_000),
});
export type NetworkDiagnostics = z.infer<typeof networkDiagnosticsSchema>;

/* What a probe posts when it has run a `diagnose` task. */
export const diagnosticsReportSchema = z.object({
  taskId: z.uuid(),
  diagnostics: networkDiagnosticsSchema,
});

/* The incident timeline event that carries one region's diagnostics. */
export const NETWORK_DIAGNOSTICS_EVENT = "network_diagnostics";
export type NetworkDiagnosticsEvent = NetworkDiagnostics & { region: string };

/*
 * Failures where the trouble may be between us and the target, so a trace can say something.
 * When the server answered (a wrong status, a missing keyword) the network was fine.
 */
const NETWORK_CAUSES: ReadonlySet<string> = new Set([
  "dns_nxdomain",
  "dns_servfail",
  "dns_timeout",
  "dns_no_records",
  "connect_refused",
  "connect_timeout",
  "connect_reset",
  "network_unreachable",
  "tls_handshake_failed",
  "response_timeout",
  "ping_loss",
  "ws_handshake_failed",
]);
export const isNetworkCause = (code: string | null | undefined): boolean =>
  code != null && NETWORK_CAUSES.has(code);

/* The host a monitor reaches over the network; undefined for types that reach nothing themselves. */
export function diagnosticHostOf(config: MonitorConfig): string | undefined {
  const fromUrl = (url: string): string | undefined => {
    try {
      return new URL(url.replace(/\{\{[^}]*\}\}/g, "x")).hostname.replace(/^\[|\]$/g, "");
    } catch {
      return undefined;
    }
  };
  switch (config.type) {
    case "http":
    case "keyword":
    case "json_query":
    case "websocket":
      return fromUrl(config.url);
    case "multistep":
      return config.steps[0] === undefined ? undefined : fromUrl(config.steps[0].url);
    case "tcp":
    case "ping":
    case "ssl":
    case "redis":
    case "mqtt":
    case "grpc":
      return config.host;
    case "dns":
      return config.hostname;
    case "domain":
    case "heartbeat":
      return undefined;
  }
}
