/*
 * Slack incoming webhook (PRODUCT.md §10): for teams that don't want to install the Slack app. The
 * URL posts to the one channel picked when it was created. Same Block Kit message as the app; Slack
 * returns no message ID, so follow-ups are new messages rather than thread replies.
 */
import { slackWebhookChannelConfigSchema, type SlackWebhookChannelConfig } from "@app/shared";
import type { OutboundHttp } from "../../../infra/http/outbound.js";
import type { ChannelAdapter } from "../types/adapter.js";
import { formConfig } from "./config.js";
import { postJson } from "./http.js";
import { renderPlain } from "./render.js";
import { slackBlocks } from "./slack.js";

/* invalid_payload, action_prohibited, channel_not_found (or a revoked URL), channel_is_archived. */
const PERMANENT = [400, 403, 404, 410];

export function createSlackWebhookAdapter(deps: {
  http: OutboundHttp;
}): ChannelAdapter<SlackWebhookChannelConfig> {
  return {
    type: "slack_webhook",
    ...formConfig("slack_webhook", slackWebhookChannelConfigSchema, "Slack webhook"),
    render(event) {
      const plain = renderPlain(event);
      return { ...plain, body: { text: plain.title, blocks: slackBlocks(event, plain) } };
    },
    async send(config, message) {
      await postJson(deps.http, {
        url: config.url,
        body: message.body,
        label: "Slack",
        permanentStatuses: PERMANENT,
      });
      return {};
    },
  };
}
