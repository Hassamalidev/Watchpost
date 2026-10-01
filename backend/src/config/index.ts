/* Typed application config, built once at boot from the environment. */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv, type Env } from "./env.js";
import type { PriceIds } from "./plans.js";

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
  email: {
    transport: "console" | "memory" | "resend";
    from: string;
    resendApiKey: string | undefined;
  };
  heartbeat: { baseUrl: string };
  /* Outbound requests to user URLs (webhooks, chat APIs) go through the SSRF guard (§12). */
  outbound: { allowCidrs: string[] };
  slack: { clientId: string; clientSecret: string; signingSecret: string | undefined } | undefined;
  telegram: { botToken: string; botUsername: string; webhookSecret: string } | undefined;
  /* Paddle Billing; undefined until the owner adds keys (checkout is off, plans still show). */
  paddle:
    | {
        environment: "sandbox" | "production";
        apiKey: string;
        webhookSecret: string;
        clientToken: string | undefined;
        foundingDiscountId: string | undefined;
      }
    | undefined;
  /* Paddle price IDs per plan, credit pack and add-on; missing ones can't be bought. */
  prices: PriceIds;
  /* Upstream funding: the AI kill switch and the monthly cap on platform-paid AI, in micro-USD. */
  funding: { aiEnabled: boolean; unfundedAiCapMicros: number; opsEmail: string | undefined };
  twilio: { accountSid: string; authToken: string } | undefined;
}

function priceIds(env: Env): PriceIds {
  return {
    plans: {
      starter: { month: env.PADDLE_PRICE_STARTER_MONTHLY, year: env.PADDLE_PRICE_STARTER_ANNUAL },
      pro: { month: env.PADDLE_PRICE_PRO_MONTHLY, year: env.PADDLE_PRICE_PRO_ANNUAL },
      business: {
        month: env.PADDLE_PRICE_BUSINESS_MONTHLY,
        year: env.PADDLE_PRICE_BUSINESS_ANNUAL,
      },
    },
    credits: { 100: env.PADDLE_PRICE_CREDITS_100, 500: env.PADDLE_PRICE_CREDITS_500 },
    addons: {
      extraMonitors100: env.PADDLE_PRICE_EXTRA_MONITORS_100,
      extraProbe: env.PADDLE_PRICE_EXTRA_PROBE,
      extraClientWorkspace: env.PADDLE_PRICE_EXTRA_CLIENT_WORKSPACE,
    },
  };
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
    email: {
      transport: env.EMAIL_TRANSPORT,
      from: env.EMAIL_FROM,
      resendApiKey: env.RESEND_API_KEY,
    },
    heartbeat: {
      baseUrl: (env.HEARTBEAT_BASE_URL ?? `${env.BETTER_AUTH_URL}/api/hb`).replace(/\/+$/, ""),
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
    paddle:
      env.PADDLE_API_KEY && env.PADDLE_WEBHOOK_SECRET
        ? {
            environment: env.PADDLE_ENV,
            apiKey: env.PADDLE_API_KEY,
            webhookSecret: env.PADDLE_WEBHOOK_SECRET,
            clientToken: env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN,
            foundingDiscountId: env.PADDLE_DISCOUNT_FOUNDING,
          }
        : undefined,
    prices: priceIds(env),
    funding: {
      aiEnabled: env.AI_ENABLED,
      unfundedAiCapMicros: Math.round(env.UNFUNDED_AI_MONTHLY_CAP_USD * 1_000_000),
      opsEmail: env.OPS_EMAIL,
    },
    twilio:
      env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN
        ? { accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN }
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
