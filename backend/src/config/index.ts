/* Typed application config, built once at boot from the environment. */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv, type Env } from "./env.js";

export { ConfigError, parseEnv, type Env } from "./env.js";

export interface AppConfig {
  env: Env["NODE_ENV"];
  isProduction: boolean;
  logLevel: Env["LOG_LEVEL"];
  api: { port: number; trustProxy: string };
  webOrigin: string;
  databaseUrl: string;
  redisUrl: string;
  /* Queues this worker consumes; undefined means every queue with a processor. */
  workerQueues: string[] | undefined;
  /* Keys for infra/crypto: the active key plus retired keys still needed to decrypt. */
  encryption: { activeKeyId: string; keys: Record<string, Buffer> };
  auth: { secret: string; baseURL: string; turnstileSecretKey: string | undefined };
  email: { transport: "console" | "memory"; from: string };
  /* Outbound requests to user URLs (webhooks, chat APIs) go through the SSRF guard (§12). */
  outbound: { allowCidrs: string[] };
  slack: { clientId: string; clientSecret: string; signingSecret: string | undefined } | undefined;
  telegram: { botToken: string; botUsername: string; webhookSecret: string } | undefined;
}

function encryptionKeys(env: Env): AppConfig["encryption"] {
  const keys: Record<string, Buffer> = {};
  for (const [id, key] of env.TOKEN_ENC_PREVIOUS_KEYS) keys[id] = Buffer.from(key, "base64");
  keys[env.TOKEN_ENC_KEY_ID] = Buffer.from(env.TOKEN_ENC_KEY, "base64");
  return { activeKeyId: env.TOKEN_ENC_KEY_ID, keys };
}

export function toAppConfig(env: Env): AppConfig {
  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === "production",
    logLevel: env.LOG_LEVEL,
    api: { port: env.API_PORT, trustProxy: env.TRUST_PROXY },
    webOrigin: env.WEB_ORIGIN,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    workerQueues: env.WORKER_QUEUES?.length ? env.WORKER_QUEUES : undefined,
    encryption: encryptionKeys(env),
    auth: {
      secret: env.BETTER_AUTH_SECRET,
      baseURL: env.BETTER_AUTH_URL,
      turnstileSecretKey: env.TURNSTILE_SECRET_KEY,
    },
    /* "resend" is rejected by the schema until P1-T18. */
    email: {
      transport: env.EMAIL_TRANSPORT === "memory" ? "memory" : "console",
      from: env.EMAIL_FROM,
    },
    outbound: { allowCidrs: env.OUTBOUND_ALLOW_CIDRS },
    slack:
      env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET
        ? {
            clientId: env.SLACK_CLIENT_ID,
            clientSecret: env.SLACK_CLIENT_SECRET,
            signingSecret: env.SLACK_SIGNING_SECRET,
          }
        : undefined,
    telegram:
      env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_USERNAME && env.TELEGRAM_WEBHOOK_SECRET
        ? {
            botToken: env.TELEGRAM_BOT_TOKEN,
            botUsername: env.TELEGRAM_BOT_USERNAME,
            webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
          }
        : undefined,
  };
}

/* In development, load the repo-root .env if it exists; production gets real env vars. */
function loadDotEnvForDevelopment(): void {
  if (process.env.NODE_ENV === "production") return;
  const path = fileURLToPath(new URL("../../../.env", import.meta.url));
  if (existsSync(path)) process.loadEnvFile(path);
}

export function loadConfig(): AppConfig {
  loadDotEnvForDevelopment();
  return toAppConfig(parseEnv(process.env));
}
