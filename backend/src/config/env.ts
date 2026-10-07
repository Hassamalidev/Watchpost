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

const paddlePriceId = z
  .string()
  .regex(/^pri_[a-z0-9]+$/, "must be a Paddle price ID (pri_…)")
  .optional();

/* PADDLE_PRICE_* variables (PRODUCT.md Appendix A); sandbox and live IDs differ. */
export const PADDLE_PRICE_ENV = [
  "PADDLE_PRICE_STARTER_MONTHLY",
  "PADDLE_PRICE_STARTER_ANNUAL",
  "PADDLE_PRICE_PRO_MONTHLY",
  "PADDLE_PRICE_PRO_ANNUAL",
  "PADDLE_PRICE_BUSINESS_MONTHLY",
  "PADDLE_PRICE_BUSINESS_ANNUAL",
  "PADDLE_PRICE_CREDITS_100",
  "PADDLE_PRICE_CREDITS_500",
  "PADDLE_PRICE_EXTRA_MONITORS_100",
  "PADDLE_PRICE_EXTRA_PROBE",
  "PADDLE_PRICE_EXTRA_CLIENT_WORKSPACE",
] as const;

/* A bare host name such as status.example.com: no scheme, port or path. */
const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/,
    "must be a host name like status.example.com",
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
  /*
   * Status pages (PRODUCT.md §6.6). Pages are served at <slug>.<STATUS_BASE_DOMAIN>; without it they
   * live at <WEB_ORIGIN>/s/<slug>. Customers point their own domain at CUSTOM_DOMAIN_CNAME_TARGET.
   */
  STATUS_BASE_DOMAIN: hostname.optional(),
  CUSTOM_DOMAIN_CNAME_TARGET: hostname.optional(),
  /*
   * How the API tells the web app that a cached page changed: POST <WEB_INTERNAL_URL>/api/revalidate
   * with this secret (the same value in the web app's environment). Without the secret pages refresh
   * on their own timer only. WEB_INTERNAL_URL defaults to WEB_ORIGIN (http://web:3000 in Compose).
   */
  REVALIDATE_SECRET: z.string().min(16, "must be at least 16 characters").optional(),
  WEB_INTERNAL_URL: z.url().optional(),
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
  /*
   * Paddle Billing (PRODUCT.md §11). The API key and the webhook secret come together; without them
   * the billing page shows plans but checkout is off. The client token is what Paddle.js uses in the
   * browser (the API hands it to the billing page, so the web build needs no Paddle variable).
   */
  PADDLE_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  PADDLE_API_KEY: z.string().min(10).optional(),
  PADDLE_WEBHOOK_SECRET: z.string().min(10).optional(),
  NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: z.string().min(10).optional(),
  /* The 30%-for-life discount for the first 100 paying workspaces (§5); created by the catalog script. */
  PADDLE_DISCOUNT_FOUNDING: z
    .string()
    .regex(/^dsc_[a-z0-9]+$/, "must be a Paddle discount ID (dsc_…)")
    .optional(),
  /*
   * Claude (PRODUCT.md §9.10). Without the key every AI feature is skipped and nothing else changes.
   * The model is the one STACK.md names; change it together with the prices in infra/anthropic.
   */
  ANTHROPIC_API_KEY: z.string().min(20).optional(),
  ANTHROPIC_MODEL: z.string().min(1).default("claude-haiku-4-5-20251001"),
  /*
   * Upstream funding (PRODUCT.md §11). AI_ENABLED is the global kill switch. Workspaces without a
   * collected payment (Free and trial) use AI on the platform's money; this caps that spend for all
   * of them together, per calendar month, in USD. 0 means "only paying workspaces use AI".
   */
  AI_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  UNFUNDED_AI_MONTHLY_CAP_USD: z.coerce.number().min(0).max(10_000).default(5),
  /* Where warnings about our own provider balances go; logged only when unset. */
  OPS_EMAIL: z.email().optional(),
  /* Cloudflare R2 (private object storage: failure evidence, later reports and uploads). */
  R2_ACCOUNT_ID: z.string().min(1).max(64).optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).max(128).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).max(256).optional(),
  R2_BUCKET: z.string().min(3).max(63).optional(),
  /* Another S3-compatible endpoint (MinIO, tests); defaults to the account's R2 endpoint. */
  R2_ENDPOINT: z.url().optional(),
  /* Twilio (SMS and voice, P3-T05); the pair also lets us read the prepaid balance. */
  TWILIO_ACCOUNT_SID: z
    .string()
    .regex(/^AC[0-9a-fA-F]{32}$/, "must look like AC followed by 32 hex characters")
    .optional(),
  TWILIO_AUTH_TOKEN: z.string().min(16).optional(),
  /* The SMS sender: a Messaging Service (preferred) or one number. Without either, no SMS. */
  TWILIO_MESSAGING_SERVICE_SID: z
    .string()
    .regex(/^MG[0-9a-fA-F]{32}$/, "must look like MG followed by 32 hex characters")
    .optional(),
  TWILIO_SMS_FROM: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/, "must be an E.164 number")
    .optional(),
  /* The caller number for voice alerts. Without it, no calls. */
  TWILIO_VOICE_FROM: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/, "must be an E.164 number")
    .optional(),
  /*
   * Web push (P4-T08): a P-256 key pair in the form browsers use (make one with
   * `pnpm --filter @app/api vapid:generate`) and a contact the push services can reach.
   */
  VAPID_PUBLIC_KEY: z
    .string()
    .regex(/^[A-Za-z0-9_-]{86,88}$/, "must be a base64url P-256 public key")
    .optional(),
  VAPID_PRIVATE_KEY: z
    .string()
    .regex(/^[A-Za-z0-9_-]{42,44}$/, "must be a base64url P-256 private key")
    .optional(),
  VAPID_SUBJECT: z
    .string()
    .regex(/^(mailto:|https:\/\/)/, "must be a mailto: or https: address")
    .optional(),
  ...(Object.fromEntries(PADDLE_PRICE_ENV.map((key) => [key, paddlePriceId])) as Record<
    (typeof PADDLE_PRICE_ENV)[number],
    typeof paddlePriceId
  >),
});

export const envSchema = baseEnvSchema.superRefine((env, ctx) => {
  if (env.NODE_ENV === "production" && env.TURNSTILE_SECRET_KEY === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["TURNSTILE_SECRET_KEY"],
      message: "is required in production (Turnstile protects sign-up)",
    });
  }
  if (env.NODE_ENV === "production" && env.REVALIDATE_SECRET === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["REVALIDATE_SECRET"],
      message: "is required in production (status pages are refreshed with it)",
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
    ["Paddle", ["PADDLE_API_KEY", "PADDLE_WEBHOOK_SECRET"]],
    ["Twilio", ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"]],
    /* VAPID_SUBJECT alone is harmless (it has a default in .env.example); the keys come as a pair. */
    ["Web push", ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"]],
    ["R2", ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]],
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
  if (env.VAPID_PUBLIC_KEY !== undefined && env.VAPID_SUBJECT === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["VAPID_SUBJECT"],
      message: "is required with the VAPID keys (a mailto: or https: contact for push services)",
    });
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
