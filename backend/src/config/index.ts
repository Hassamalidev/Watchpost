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
