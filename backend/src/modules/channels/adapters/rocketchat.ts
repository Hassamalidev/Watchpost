/*
 * Rocket.Chat incoming webhook (PRODUCT.md §10): the alert title as text plus a Slack-style
 * attachment with the facts. Webhooks can't thread or edit, so follow-ups are new messages.
 */
import { rocketChatChannelConfigSchema, type RocketChatChannelConfig } from "@app/shared";
import type { OutboundHttp } from "../../../infra/http/outbound.js";
import { ChannelDeliveryError, type ChannelAdapter } from "../types/adapter.js";
import { formConfig } from "./config.js";
import { parseJson, postJson } from "./http.js";
import { renderPlain, slackStyleAttachment } from "./render.js";

/* A deleted or disabled integration, or a wrong token. */
const PERMANENT = [401, 403, 404, 410];

export function createRocketChatAdapter(deps: {
  http: OutboundHttp;
}): ChannelAdapter<RocketChatChannelConfig> {
  return {
    type: "rocketchat",
    ...formConfig("rocketchat", rocketChatChannelConfigSchema, "Rocket.Chat"),
    render(event) {
      const plain = renderPlain(event);
      return {
        ...plain,
        body: { text: plain.title, attachments: [slackStyleAttachment(event, plain)] },
      };
    },
    async send(config, message) {
      const res = await postJson(deps.http, {
        url: config.url,
        body: message.body,
        label: "Rocket.Chat",
        permanentStatuses: PERMANENT,
      });
      /* An integration script can refuse a message with 200 and `success: false`. */
      const body = parseJson(res.body) as { success?: boolean; error?: string } | undefined;
      if (body?.success === false) {
        throw new ChannelDeliveryError(
          `Rocket.Chat refused the message: ${body.error ?? "no reason given"}`,
        );
      }
      return {};
    },
  };
}
