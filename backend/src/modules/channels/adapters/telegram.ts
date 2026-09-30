/*
 * Telegram (PRODUCT.md §10, one-way in P1): our bot posts to the chat that opened the channel's deep
 * link. Follow-ups reply to the first message, which is edited to the latest state. Inline buttons
 * arrive in P4.
 */
import { telegramChannelConfigSchema, type TelegramChannelConfig } from "@app/shared";
import { ValidationError } from "../../../core/errors.js";
import type { OutboundHttp } from "../../../infra/http/outbound.js";
import { ChannelDeliveryError, type ChannelAdapter } from "../types/adapter.js";
import { call, parseJson } from "./http.js";
import { renderPlain } from "./render.js";

export const TELEGRAM_API = "https://api.telegram.org";

export interface TelegramApi {
  call(method: string, payload: object): Promise<Record<string, unknown>>;
}

/* Calls the Bot API; failures become ChannelDeliveryError (403/400/401 are permanent). */
export function createTelegramApi(deps: { http: OutboundHttp; botToken: string }): TelegramApi {
  return {
    async call(method, payload) {
      const res = await call(
        deps.http,
        {
          method: "POST",
          url: `${TELEGRAM_API}/bot${deps.botToken}/${method}`,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
        "Telegram",
      );
      const body = parseJson(res.body) as
        { ok?: boolean; description?: string; result?: Record<string, unknown> } | undefined;
      if (body?.ok === true) return body.result ?? {};
      const description = body?.description ?? `HTTP ${res.status}`;
      const permanent = [400, 401, 403].includes(res.status);
      throw new ChannelDeliveryError(`Telegram refused the message: ${description}`, permanent);
    },
  };
}

export function createTelegramAdapter(deps: {
  api: TelegramApi;
}): ChannelAdapter<TelegramChannelConfig> {
  const parse = (input: unknown) => {
    const parsed = telegramChannelConfigSchema.safeParse(input ?? {});
    if (!parsed.success)
      throw new ValidationError(`Invalid Telegram channel: ${parsed.error.message}`);
    return parsed.data;
  };

  return {
    type: "telegram",
    parseConfig: parse,
    /* The chat is set only by linking through the bot, never by the API caller. */
    async prepare(_input, ctx) {
      return ctx.previous === undefined ? parse({}) : parse(ctx.previous);
    },
    render: renderPlain,
    async send(config, message, meta) {
      if (config.chatId === null) {
        throw new ChannelDeliveryError(
          "This Telegram channel isn't linked to a chat yet; open its link in Telegram first.",
          true,
        );
      }
      const replyTo = Number(meta.threadRef?.split(":")[1]);
      const result = await deps.api.call("sendMessage", {
        chat_id: config.chatId,
        text: message.text,
        link_preview_options: { is_disabled: true },
        ...(Number.isInteger(replyTo)
          ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
          : {}),
      });
      const messageId = result.message_id;
      return {
        providerRef: typeof messageId === "number" ? `${config.chatId}:${messageId}` : undefined,
      };
    },
    async update(config, ref, message) {
      const [chatId, messageId] = ref.split(":");
      if (config.chatId === null || chatId !== config.chatId) return;
      try {
        await deps.api.call("editMessageText", {
          chat_id: chatId,
          message_id: Number(messageId),
          text: message.text,
          link_preview_options: { is_disabled: true },
        });
      } catch (err) {
        /* Editing to the same text is an error in Telegram's eyes, not ours. */
        if (!(err instanceof Error && err.message.includes("message is not modified"))) throw err;
      }
    },
  };
}
