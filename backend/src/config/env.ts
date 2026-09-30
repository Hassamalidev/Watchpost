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

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  WEB_ORIGIN: z.url(),
  /* Express "trust proxy" value; Caddy sits in front of the API on the Docker network. */
  TRUST_PROXY: z.string().default("loopback, linklocal, uniquelocal"),
  DATABASE_URL: postgresUrl,
  REDIS_URL: redisUrl,
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
