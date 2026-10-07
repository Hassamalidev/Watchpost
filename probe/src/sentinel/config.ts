/*
 * Sentinel settings from the environment (PRODUCT.md §13, Appendix A "Sentinel"). The sentinel runs
 * on a server of another provider, watches our own platform from outside and tells the founders
 * directly, so it shares nothing with the platform except its public addresses.
 */
import { z } from "zod";

const schema = z.object({
  /*
   * What to watch, comma-separated: `Name=https://…` or just a URL. A URL ending in /api/ready is
   * read as our readiness answer (its failing checks and warnings are reported by name).
   */
  SENTINEL_TARGETS: z.string().min(1),
  SENTINEL_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(600).default(30),
  SENTINEL_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  /* How often a page is repeated while a target stays down. */
  SENTINEL_REPEAT_MINUTES: z.coerce.number().int().min(1).max(1_440).default(15),
  SENTINEL_TELEGRAM_BOT_TOKEN: z.string().min(10).optional(),
  SENTINEL_TELEGRAM_CHAT_ID: z.string().min(1).optional(),
  /* Founders' phone numbers in E.164, comma-separated. */
  SENTINEL_SMS_TO: z.string().optional(),
  SENTINEL_SMS_FROM: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  /* Serves our own status page (`/`) and `/healthz`; 0 picks a free port. */
  SENTINEL_PORT: z.coerce.number().int().min(0).max(65_535).default(8080),
  SENTINEL_PAGE_TITLE: z.string().min(1).max(100).default("Watchpost status"),
  /* Checks and logs, but sends nothing: for trying the setup. */
  SENTINEL_DRY_RUN: z.enum(["true", "false"]).default("false"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export interface SentinelTarget {
  /* Shown on the status page and in pages; never the URL. */
  name: string;
  url: string;
  kind: "ready" | "http";
}

export interface SentinelConfig {
  targets: SentinelTarget[];
  intervalMs: number;
  timeoutMs: number;
  repeatMs: number;
  telegram: { botToken: string; chatId: string } | undefined;
  sms: { accountSid: string; authToken: string; from: string; to: string[] } | undefined;
  port: number;
  pageTitle: string;
  dryRun: boolean;
  logLevel: string;
}

export class SentinelConfigError extends Error {
  constructor(issues: string[]) {
    super(`Invalid sentinel configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "SentinelConfigError";
  }
}

const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

function parseTarget(entry: string): SentinelTarget | string {
  const eq = entry.indexOf("=");
  /* "Name=https://…": the first "=" before the scheme separates the name. */
  const named = eq > 0 && !entry.slice(0, eq).includes("://");
  const raw = named ? entry.slice(eq + 1).trim() : entry;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `SENTINEL_TARGETS: "${raw}" is not a URL`;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return `SENTINEL_TARGETS: "${raw}" must be an http(s) URL`;
  }
  return {
    name: named ? entry.slice(0, eq).trim() : url.hostname,
    url: url.toString(),
    kind: url.pathname.replace(/\/+$/, "").endsWith("/api/ready") ? "ready" : "http",
  };
}

export function loadSentinelConfig(env: Record<string, string | undefined>): SentinelConfig {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ""),
  );
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    throw new SentinelConfigError(
      result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  const e = result.data;
  const issues: string[] = [];

  const targets: SentinelTarget[] = [];
  for (const entry of list(e.SENTINEL_TARGETS)) {
    const parsed = parseTarget(entry);
    if (typeof parsed === "string") issues.push(parsed);
    else if (targets.some((t) => t.name === parsed.name)) {
      issues.push(`SENTINEL_TARGETS: two targets are named "${parsed.name}"; name them (Name=URL)`);
    } else targets.push(parsed);
  }
  if (targets.length === 0) issues.push("SENTINEL_TARGETS: list at least one URL");

  const dryRun = e.SENTINEL_DRY_RUN === "true";
  const hasToken = e.SENTINEL_TELEGRAM_BOT_TOKEN !== undefined;
  const hasChat = e.SENTINEL_TELEGRAM_CHAT_ID !== undefined;
  if (hasToken !== hasChat) {
    issues.push("Telegram needs both SENTINEL_TELEGRAM_BOT_TOKEN and SENTINEL_TELEGRAM_CHAT_ID");
  }
  const to = list(e.SENTINEL_SMS_TO);
  const smsKeys = [e.TWILIO_ACCOUNT_SID, e.TWILIO_AUTH_TOKEN, e.SENTINEL_SMS_FROM];
  if (to.length > 0 && smsKeys.some((k) => k === undefined)) {
    issues.push(
      "SMS needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and SENTINEL_SMS_FROM besides SENTINEL_SMS_TO",
    );
  }
  for (const number of to) {
    if (!/^\+[1-9]\d{6,14}$/.test(number)) {
      issues.push(`SENTINEL_SMS_TO: "${number}" is not a phone number like +14155550100`);
    }
  }
  if (!dryRun && !(hasToken && hasChat) && to.length === 0) {
    issues.push(
      "Nobody would be told: set Telegram or SMS, or SENTINEL_DRY_RUN=true to try the checks",
    );
  }
  if (issues.length > 0) throw new SentinelConfigError(issues);

  return {
    targets,
    intervalMs: e.SENTINEL_INTERVAL_SECONDS * 1_000,
    timeoutMs: e.SENTINEL_TIMEOUT_MS,
    repeatMs: e.SENTINEL_REPEAT_MINUTES * 60_000,
    telegram:
      e.SENTINEL_TELEGRAM_BOT_TOKEN && e.SENTINEL_TELEGRAM_CHAT_ID
        ? { botToken: e.SENTINEL_TELEGRAM_BOT_TOKEN, chatId: e.SENTINEL_TELEGRAM_CHAT_ID }
        : undefined,
    sms:
      to.length > 0 && e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && e.SENTINEL_SMS_FROM
        ? {
            accountSid: e.TWILIO_ACCOUNT_SID,
            authToken: e.TWILIO_AUTH_TOKEN,
            from: e.SENTINEL_SMS_FROM,
            to,
          }
        : undefined,
    port: e.SENTINEL_PORT,
    pageTitle: e.SENTINEL_PAGE_TITLE,
    dryRun,
    logLevel: e.LOG_LEVEL,
  };
}
