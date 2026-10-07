/*
 * How the sentinel reaches the founders (PRODUCT.md §13): Telegram and SMS, called directly, never
 * through our own alert pipeline, which may be the thing that is down. Two plain HTTPS calls, no
 * SDKs. A page goes to both; a notice to Telegram only (or SMS when Telegram isn't set up).
 */
import type { SentinelConfig } from "./config.js";
import type { Message } from "./watch.js";

export const TELEGRAM_API = "https://api.telegram.org";
export const TWILIO_API = "https://api.twilio.com";
const SEND_TIMEOUT_MS = 10_000;
/* One SMS segment is 160 characters; two is plenty for a page. */
const SMS_MAX = 300;

export interface Notifier {
  /* True when at least one channel accepted the message. */
  send(message: Message): Promise<boolean>;
}

export function createNotifier(options: {
  config: Pick<SentinelConfig, "telegram" | "sms" | "dryRun">;
  fetch: typeof fetch;
  log: (event: Record<string, unknown>, text: string) => void;
}): Notifier {
  const { config, log } = options;

  async function telegram(text: string): Promise<boolean> {
    if (config.telegram === undefined) return false;
    const res = await options.fetch(`${TELEGRAM_API}/bot${config.telegram.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: config.telegram.chatId, text }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Telegram answered HTTP ${res.status}`);
    return true;
  }

  async function sms(text: string): Promise<boolean> {
    const settings = config.sms;
    if (settings === undefined) return false;
    const auth = Buffer.from(`${settings.accountSid}:${settings.authToken}`).toString("base64");
    const results = await Promise.allSettled(
      settings.to.map(async (to) => {
        const res = await options.fetch(
          `${TWILIO_API}/2010-04-01/Accounts/${settings.accountSid}/Messages.json`,
          {
            method: "POST",
            headers: {
              authorization: `Basic ${auth}`,
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              To: to,
              From: settings.from,
              Body: text.slice(0, SMS_MAX),
            }).toString(),
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          },
        );
        if (!res.ok) throw new Error(`Twilio answered HTTP ${res.status}`);
      }),
    );
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length === results.length) {
      throw (failed[0] as PromiseRejectedResult).reason;
    }
    return true;
  }

  return {
    async send(message) {
      if (config.dryRun) {
        log({ kind: message.level, target: message.target }, `dry run: ${message.text}`);
        return true;
      }
      const text = `Watchpost sentinel\n${message.text}`;
      const viaSms = message.level === "page" || config.telegram === undefined;
      const attempts = await Promise.allSettled([telegram(text), viaSms ? sms(text) : false]);
      for (const attempt of attempts) {
        if (attempt.status === "rejected") {
          /* The reason names the provider and a status code, never a token. */
          log({ target: message.target, err: String(attempt.reason) }, "a notification failed");
        }
      }
      return attempts.some((a) => a.status === "fulfilled" && a.value === true);
    },
  };
}
