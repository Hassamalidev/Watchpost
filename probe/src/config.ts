/* Probe settings from the environment (PRODUCT.md Appendix A "Probe container"). Parsed once at start. */
import { z } from "zod";
import { REGIONS, parseProbeToken, privateRegionOf } from "@app/shared";

const schema = z.object({
  API_URL: z.url(),
  /*
   * A private probe is set up with one token from the app (`wpp_<id>.<secret>`), which also makes
   * it private and names its location. Our own probes get an ID, a secret and a region.
   */
  PROBE_TOKEN: z.string().min(1).optional(),
  PROBE_ID: z.uuid().optional(),
  PROBE_SECRET: z.string().min(32, "must be at least 32 characters").optional(),
  PROBE_REGION: z.enum(REGIONS).optional(),
  PROBE_MODE: z.enum(["managed", "private"]).optional(),
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
  /* One of our regions, or `private:<probe ID>` for a private probe. */
  region: string;
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
    /* Everything wrong at once, including what a probe without a token still has to be given. */
    const withoutToken =
      cleaned.PROBE_TOKEN === undefined
        ? ["PROBE_ID", "PROBE_SECRET"]
            .filter((key) => cleaned[key] === undefined)
            .map((key) => `${key}: is required (or set PROBE_TOKEN)`)
        : [];
    throw new ProbeConfigError([
      ...result.error.issues.map((i) => {
        const key = i.path.join(".");
        return `${key}: ${cleaned[key] === undefined ? "is required" : i.message}`;
      }),
      ...withoutToken,
    ]);
  }
  const e = result.data;
  const token = e.PROBE_TOKEN === undefined ? undefined : parseProbeToken(e.PROBE_TOKEN);
  if (e.PROBE_TOKEN !== undefined && token === undefined) {
    throw new ProbeConfigError(["PROBE_TOKEN: is not a probe token (it starts with wpp_)"]);
  }
  const probeId = token?.probeId ?? e.PROBE_ID;
  const secret = token?.secret ?? e.PROBE_SECRET;
  const mode = e.PROBE_MODE ?? (token === undefined ? "managed" : "private");
  const region =
    mode === "private" && probeId !== undefined ? privateRegionOf(probeId) : e.PROBE_REGION;
  const missing = [
    ...(probeId === undefined ? ["PROBE_ID: is required (or set PROBE_TOKEN)"] : []),
    ...(secret === undefined ? ["PROBE_SECRET: is required (or set PROBE_TOKEN)"] : []),
    ...(region === undefined ? ["PROBE_REGION: is required"] : []),
  ];
  if (probeId === undefined || secret === undefined || region === undefined) {
    throw new ProbeConfigError(missing);
  }
  return {
    apiUrl: e.API_URL.replace(/\/+$/, ""),
    probeId,
    secret,
    region,
    mode,
    concurrency: e.PROBE_CONCURRENCY,
    bufferMaxAgeMs: e.PROBE_BUFFER_MAX_AGE_SECONDS * 1_000,
    bufferDir: e.PROBE_BUFFER_DIR ?? (mode === "private" ? "/var/lib/watchpost-probe" : undefined),
    healthPort: e.PROBE_HEALTH_PORT,
    logLevel: e.LOG_LEVEL,
    allowCidrs: list(e.PROBE_ALLOW_CIDRS),
    denyHosts: [...new Set([...list(e.PROBE_DENY_HOSTS), new URL(e.API_URL).hostname])],
  };
}
