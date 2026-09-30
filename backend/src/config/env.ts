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

const commaList = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v !== ""),
  );

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
  /* Where transactional email goes: logged (console), captured (memory, tests) or sent (resend). */
  EMAIL_TRANSPORT: z.enum(["console", "memory", "resend"]).default("console"),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("Watchpost <alerts@localhost>"),
  /*
   * Private ranges the API may still reach for outbound webhooks and chat APIs, for local test
   * receivers only (CIDRs, comma-separated). Refused in production.
   */
  OUTBOUND_ALLOW_CIDRS: commaList,
  /* Public base of heartbeat ping URLs (hb.<domain>); defaults to <BETTER_AUTH_URL>/api/hb. */
  HEARTBEAT_BASE_URL: z.url().optional(),
  /* Slack app (PRODUCT.md §10); Slack channels are available only when the app is configured. */
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  /* Telegram bot (PRODUCT.md §10); Telegram channels need all three. */
  TELEGRAM_BOT_TOKEN: z
    .string()
    .regex(/^\d+:[A-Za-z0-9_-]+$/, "must look like 123456:ABC-xyz")
    .optional(),
  TELEGRAM_BOT_USERNAME: z
    .string()
    .regex(/^[A-Za-z0-9_]{5,32}$/)
    .optional(),
  TELEGRAM_WEBHOOK_SECRET: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,256}$/, "must be 16-256 letters, digits, _ or -")
    .optional(),
});

export const envSchema = baseEnvSchema.superRefine((env, ctx) => {
  if (env.NODE_ENV === "production" && env.TURNSTILE_SECRET_KEY === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["TURNSTILE_SECRET_KEY"],
      message: "is required in production (Turnstile protects sign-up)",
    });
  }
  if (env.NODE_ENV === "production" && env.OUTBOUND_ALLOW_CIDRS.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["OUTBOUND_ALLOW_CIDRS"],
      message: "is for local test receivers only and must be empty in production",
    });
  }
  const groups: Array<[string, string[]]> = [
    ["Slack", ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"]],
    ["Telegram", ["TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_USERNAME", "TELEGRAM_WEBHOOK_SECRET"]],
  ];
  for (const [name, keys] of groups) {
    const set = keys.filter((k) => env[k as keyof typeof env] !== undefined);
    if (set.length > 0 && set.length < keys.length) {
      for (const key of keys.filter((k) => !set.includes(k))) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `is required when ${name} is configured (set all of ${keys.join(", ")} or none)`,
        });
      }
    }
  }
  if (env.EMAIL_TRANSPORT === "resend" && env.RESEND_API_KEY === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["RESEND_API_KEY"],
      message: 'is required when EMAIL_TRANSPORT is "resend"',
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
