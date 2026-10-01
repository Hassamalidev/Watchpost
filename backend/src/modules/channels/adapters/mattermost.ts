/*
 * Mattermost incoming webhook (PRODUCT.md §10): a Slack-style attachment with a colored bar, a title
 * linking to the incident and the facts as fields. Webhooks can't thread or edit, so follow-ups are
 * new messages.
 */
import { mattermostChannelConfigSchema, type MattermostChannelConfig } from "@app/shared";
import type { OutboundHttp } from "../../../infra/http/outbound.js";
import type { ChannelAdapter } from "../types/adapter.js";
import { formConfig } from "./config.js";
import { postJson } from "./http.js";
import { renderPlain, slackStyleAttachment } from "./render.js";

/* A deleted or disabled webhook. Other 4xx answers are retried: their meaning varies by version. */
const PERMANENT = [401, 403, 404, 410];

export function createMattermostAdapter(deps: {
  http: OutboundHttp;
}): ChannelAdapter<MattermostChannelConfig> {
  return {
    type: "mattermost",
    ...formConfig("mattermost", mattermostChannelConfigSchema, "Mattermost"),
    render(event) {
      const plain = renderPlain(event);
      return { ...plain, body: { attachments: [slackStyleAttachment(event, plain)] } };
    },
    async send(config, message) {
      await postJson(deps.http, {
        url: config.url,
        body: message.body,
        label: "Mattermost",
        permanentStatuses: PERMANENT,
      });
      return {};
    },
  };
}
