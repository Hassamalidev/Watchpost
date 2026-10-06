/*
 * Points the Telegram bot at our webhook (PRODUCT.md §10), with the secret token Telegram sends back
 * in `X-Telegram-Bot-Api-Secret-Token` on every update:
 *   pnpm --filter @app/api telegram:webhook
 * Uses BETTER_AUTH_URL (the API's public URL) and the TELEGRAM_* variables. Run it once per
 * environment, and again if the API URL or the secret changes.
 */
import { createAddressPolicy } from "@app/shared";
import { loadConfig } from "../src/config/index.js";
import { createOutboundHttp } from "../src/infra/http/outbound.js";
import { createTelegramApi } from "../src/modules/channels/adapters/telegram.js";

const config = loadConfig();
if (config.telegram === undefined) {
  process.stderr.write(
    "Set TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME and TELEGRAM_WEBHOOK_SECRET first.\n",
  );
  process.exit(1);
}
const url = `${config.auth.baseURL}/api/webhooks/telegram`;
if (!url.startsWith("https://")) {
  process.stderr.write(`Telegram needs an https webhook URL; BETTER_AUTH_URL gives ${url}\n`);
  process.exit(1);
}
const api = createTelegramApi({
  http: createOutboundHttp({ policy: createAddressPolicy() }),
  botToken: config.telegram.botToken,
});
await api.call("setWebhook", {
  url,
  secret_token: config.telegram.webhookSecret,
  allowed_updates: ["message"],
  drop_pending_updates: true,
});
process.stdout.write(`Telegram webhook set to ${url}\n`);
