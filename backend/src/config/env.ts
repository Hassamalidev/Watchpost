/*
 * Environment schema. This folder is the only place that reads process.env (PRODUCT.md §7.11).
 * Add new variables here, to .env.example and to PRODUCT.md Appendix A in the same commit.
 */
import { z } from "zod";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const redisUrl = z.string().regex(/^rediss?:\/\/.+/, "must be a redis:// or rediss:// URL");

const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\/.+/, "must be a postgres:// or postgresql:// URL");

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const isAes256Key = (value: string) =>
  /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, "base64").length === 32;

const encryptionKey = z
  .string()
  .refine(isAes256Key, "must be 32 random bytes in base64 (see .env.example for a command)");

/* "k0:<base64>,k-old:<base64>" — retired keys kept only to decrypt old values during rotation. */
const previousKeys = z
  .string()
  .optional()
  .transform((value, ctx) => {
    const entries: Array<[string, string]> = [];
    for (const part of (value ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)) {
      const [id, key, extra] = part.split(":");
      if (
        id === undefined ||
        key === undefined ||
        extra !== undefined ||
        !KEY_ID.test(id) ||
        !isAes256Key(key)
      ) {
        ctx.addIssue({
          code: "custom",
          message: `entries must look like "<keyId>:<base64 32-byte key>"`,
        });
        return z.NEVER;
      }
      entries.push([id, key]);
    }
    return entries;
  });

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  WEB_ORIGIN: z.url(),
  /* Express "trust proxy" value; Caddy sits in front of the API on the Docker network. */
  TRUST_PROXY: z.string().default("loopback, linklocal, uniquelocal"),
  DATABASE_URL: postgresUrl,
  REDIS_URL: redisUrl,
  /* AES-256-GCM key for third-party tokens and secrets (PRODUCT.md §12), with its key ID. */
  TOKEN_ENC_KEY: encryptionKey,
  TOKEN_ENC_KEY_ID: z.string().regex(KEY_ID, "must be 1-32 letters, digits, - or _").default("k1"),
  TOKEN_ENC_PREVIOUS_KEYS: previousKeys,
  /* Comma-separated queues this worker process consumes; empty means all (PRODUCT.md §7.5). */
  WORKER_QUEUES: z
    .string()
    .optional()
    .transform((value) =>
      value
        ?.split(",")
        .map((q) => q.trim())
        .filter((q) => q !== ""),
    ),
  /* Better Auth: signing secret and the API's public base URL (links in emails point here). */
  BETTER_AUTH_SECRET: z.string().min(32, "must be at least 32 characters"),
  BETTER_AUTH_URL: z.url(),
  /* Cloudflare Turnstile on sign-up (PRODUCT.md §12); required in production. */
  TURNSTILE_SECRET_KEY: z.string().optional(),
  /* Where transactional email goes. "resend" arrives with the templates in P1-T18. */
  EMAIL_TRANSPORT: z.enum(["console", "memory", "resend"]).default("console"),
  EMAIL_FROM: z.string().default("Watchpost <alerts@localhost>"),
});

export const envSchema = baseEnvSchema.superRefine((env, ctx) => {
  if (env.NODE_ENV === "production" && env.TURNSTILE_SECRET_KEY === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["TURNSTILE_SECRET_KEY"],
      message: "is required in production (Turnstile protects sign-up)",
    });
  }
  if (env.EMAIL_TRANSPORT === "resend") {
    ctx.addIssue({
      code: "custom",
      path: ["EMAIL_TRANSPORT"],
      message: 'the "resend" transport arrives in P1-T18; use "console" until then',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  /* Treat empty strings as unset so `KEY=` in .env falls back to the default or fails as missing. */
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ""),
  );
  const result = envSchema.safeParse(cleaned);
  if (result.success) return result.data;
  throw new ConfigError(
    result.error.issues.map((issue) => {
      const key = issue.path.join(".") || "(root)";
      const message =
        issue.code === "invalid_type" && cleaned[key] === undefined ? "is required" : issue.message;
      return `${key}: ${message}`;
    }),
  );
}
