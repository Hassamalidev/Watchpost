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
  /* Requests one API key may make per minute on /api/v1. */
  apiKeyRateLimitPerMinute: number;
  /* The container image customers run as a private probe. */
  privateProbeImage: string;
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
  /* Claude; undefined until the owner adds a key (AI features are skipped). */
  ai: { apiKey: string; model: string } | undefined;
  /* Upstream funding: the AI kill switch and the monthly cap on platform-paid AI, in micro-USD. */
  funding: { aiEnabled: boolean; unfundedAiCapMicros: number; opsEmail: string | undefined };
  /* Private object storage; without it production keeps no evidence bundles. */
  r2:
    | {
        accountId: string;
        accessKeyId: string;
        secretAccessKey: string;
        bucket: string;
        endpoint: string | undefined;
      }
    | undefined;
  /* Web push keys; undefined until the owner generates a pair (no device notifications then). */
  webPush: { publicKey: string; privateKey: string; subject: string } | undefined;
  /* Status pages: where they are served and how the web app's cache is told about changes. */
  statusPages: {
    baseDomain: string | undefined;
    cnameTarget: string | undefined;
    revalidate: { url: string; secret: string } | undefined;
  };
  twilio:
    | {
        accountSid: string;
        authToken: string;
        messagingServiceSid: string | undefined;
        smsFrom: string | undefined;
        voiceFrom: string | undefined;
      }
    | undefined;
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

/* Known to the web app too (`app/api/revalidate`); never accepted in production. */
export const DEV_REVALIDATE_SECRET = "watchpost-dev-revalidate";

/* The placeholders from .env.example (status.example.com) count as "not set". */
const realHost = (host: string | undefined) =>
  host === undefined || host === "example.com" || host.endsWith(".example.com") ? undefined : host;

export function toAppConfig(env: Env): AppConfig {
  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === "production",
    logLevel: env.LOG_LEVEL,
    api: { port: env.API_PORT, trustProxy: env.TRUST_PROXY },
    apiKeyRateLimitPerMinute: env.API_KEY_RATE_LIMIT_PER_MINUTE,
    privateProbeImage: env.PRIVATE_PROBE_IMAGE,
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
    ai:
      env.ANTHROPIC_API_KEY === undefined
        ? undefined
        : { apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL },
    funding: {
      aiEnabled: env.AI_ENABLED,
      unfundedAiCapMicros: Math.round(env.UNFUNDED_AI_MONTHLY_CAP_USD * 1_000_000),
      opsEmail: env.OPS_EMAIL,
    },
    r2:
      env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET
        ? {
            accountId: env.R2_ACCOUNT_ID,
            accessKeyId: env.R2_ACCESS_KEY_ID,
            secretAccessKey: env.R2_SECRET_ACCESS_KEY,
            bucket: env.R2_BUCKET,
            endpoint: env.R2_ENDPOINT,
          }
        : undefined,
    statusPages: {
      baseDomain: realHost(env.STATUS_BASE_DOMAIN),
      cnameTarget: realHost(env.CUSTOM_DOMAIN_CNAME_TARGET),
      /* Development has a fixed secret the web app also knows, so pages refresh without setup. */
      revalidate:
        env.REVALIDATE_SECRET === undefined && env.NODE_ENV !== "development"
          ? undefined
          : {
              url: `${(env.WEB_INTERNAL_URL ?? env.WEB_ORIGIN).replace(/\/+$/, "")}/api/revalidate`,
              secret: env.REVALIDATE_SECRET ?? DEV_REVALIDATE_SECRET,
            },
    },
    webPush:
      env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT
        ? {
            publicKey: env.VAPID_PUBLIC_KEY,
            privateKey: env.VAPID_PRIVATE_KEY,
            subject: env.VAPID_SUBJECT,
          }
        : undefined,
    twilio:
      env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN
        ? {
            accountSid: env.TWILIO_ACCOUNT_SID,
            authToken: env.TWILIO_AUTH_TOKEN,
            messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
            smsFrom: env.TWILIO_SMS_FROM,
            voiceFrom: env.TWILIO_VOICE_FROM,
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
