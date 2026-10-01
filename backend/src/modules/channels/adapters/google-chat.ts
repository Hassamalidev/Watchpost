/*
 * Google Chat incoming webhook (PRODUCT.md §10): a card with the state, the facts and an "Open
 * incident" button. Every message of an incident carries the same thread key, so follow-ups land in
 * the first message's thread (spaces without threads get separate messages). Webhooks can't edit.
 */
import { googleChatChannelConfigSchema, type GoogleChatChannelConfig } from "@app/shared";
import type { OutboundHttp } from "../../../infra/http/outbound.js";
import type { AlertEvent, ChannelAdapter, RenderedMessage } from "../types/adapter.js";
import { formConfig } from "./config.js";
import { postJson } from "./http.js";
import {
  STATE_EMOJI,
  STATE_LABEL,
  alertFacts,
  escapeHtml,
  explanationLines,
  renderPlain,
  truncate,
} from "./render.js";

/* A bad payload, a deleted webhook or a space we were removed from won't fix themselves. */
const PERMANENT = [400, 401, 403, 404];

export function googleChatCard(event: AlertEvent, message: RenderedMessage) {
  const { incident } = event;
  const heading = `${STATE_EMOJI[event.kind]} ${STATE_LABEL[event.kind]}`;
  if (event.kind === "test") {
    return {
      header: { title: heading, subtitle: "Watchpost" },
      sections: [{ widgets: [{ textParagraph: { text: escapeHtml(message.text) } }] }],
    };
  }
  const why = explanationLines(event);
  return {
    header: {
      title: truncate(`${heading} · ${incident.monitorName ?? incident.title}`, 200),
      subtitle: truncate(`#${incident.number} ${incident.title}`, 200),
    },
    sections: [
      {
        widgets: [
          ...alertFacts(event).map((f) => ({
            decoratedText: { topLabel: f.label, text: escapeHtml(f.value) },
          })),
          ...(why.length > 0
            ? [{ textParagraph: { text: why.map(escapeHtml).join("<br>") } }]
            : []),
          {
            buttonList: {
              buttons: [{ text: "Open incident", onClick: { openLink: { url: incident.url } } }],
            },
          },
        ],
      },
    ],
  };
}

export function createGoogleChatAdapter(deps: {
  http: OutboundHttp;
}): ChannelAdapter<GoogleChatChannelConfig> {
  return {
    type: "google_chat",
    ...formConfig("google_chat", googleChatChannelConfigSchema, "Google Chat"),
    render(event) {
      const plain = renderPlain(event);
      return {
        ...plain,
        body: {
          cardsV2: [
            { cardId: `watchpost-${event.incident.id}`, card: googleChatCard(event, plain) },
          ],
          ...(event.kind === "test"
            ? {}
            : { thread: { threadKey: `watchpost-${event.incident.id}` } }),
        },
      };
    },
    async send(config, message) {
      const url = new URL(config.url);
      url.searchParams.set("messageReplyOption", "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
      await postJson(deps.http, {
        url: url.toString(),
        body: message.body,
        label: "Google Chat",
        permanentStatuses: PERMANENT,
      });
      return {};
    },
  };
}
