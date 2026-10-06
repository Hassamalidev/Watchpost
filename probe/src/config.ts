/* Probe settings from the environment (PRODUCT.md Appendix A "Probe container"). Parsed once at start. */
import { z } from "zod";
import { REGIONS } from "@app/shared";

const schema = z.object({
  API_URL: z.url(),
  PROBE_ID: z.uuid(),
  PROBE_SECRET: z.string().min(32, "must be at least 32 characters"),
  PROBE_REGION: z.enum(REGIONS),
  PROBE_MODE: z.enum(["managed", "private"]).default("managed"),
  PROBE_CONCURRENCY: z.coerce.number().int().min(1).max(5_000).default(200),
  /* How long unsent results are kept while the API is unreachable (§7.6: 10 minutes). */
  PROBE_BUFFER_MAX_AGE_SECONDS: z.coerce.number().int().min(10).max(86_400).default(600),
  /* Private probes persist the buffer to disk so a restart loses nothing. */
  PROBE_BUFFER_DIR: z.string().min(1).optional(),
  PROBE_HEALTH_PORT: z.coerce.number().int().min(0).max(65_535).default(8080),
  /* Comma-separated CIDRs a managed probe may reach despite the SSRF rules (local development only). */
  PROBE_ALLOW_CIDRS: z.string().optional(),
  /* Comma-separated hostnames that are never checked (our own infrastructure); the API host is added. */
  PROBE_DENY_HOSTS: z.string().optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export interface ProbeConfig {
  apiUrl: string;
  probeId: string;
  secret: string;
  region: (typeof REGIONS)[number];
  mode: "managed" | "private";
  concurrency: number;
  bufferMaxAgeMs: number;
  bufferDir: string | undefined;
  healthPort: number;
  logLevel: string;
  allowCidrs: string[];
  denyHosts: string[];
}

const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

export class ProbeConfigError extends Error {
  constructor(issues: string[]) {
    super(`Invalid probe configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "ProbeConfigError";
  }
}

export function loadProbeConfig(env: Record<string, string | undefined>): ProbeConfig {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ""),
  );
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    throw new ProbeConfigError(
      result.error.issues.map((i) => {
        const key = i.path.join(".");
        return `${key}: ${cleaned[key] === undefined ? "is required" : i.message}`;
      }),
    );
  }
  const e = result.data;
  return {
    apiUrl: e.API_URL.replace(/\/+$/, ""),
    probeId: e.PROBE_ID,
    secret: e.PROBE_SECRET,
    region: e.PROBE_REGION,
    mode: e.PROBE_MODE,
    concurrency: e.PROBE_CONCURRENCY,
    bufferMaxAgeMs: e.PROBE_BUFFER_MAX_AGE_SECONDS * 1_000,
    bufferDir:
      e.PROBE_BUFFER_DIR ?? (e.PROBE_MODE === "private" ? "/var/lib/watchpost-probe" : undefined),
    healthPort: e.PROBE_HEALTH_PORT,
    logLevel: e.LOG_LEVEL,
    allowCidrs: list(e.PROBE_ALLOW_CIDRS),
    denyHosts: [...new Set([...list(e.PROBE_DENY_HOSTS), new URL(e.API_URL).hostname])],
  };
}
