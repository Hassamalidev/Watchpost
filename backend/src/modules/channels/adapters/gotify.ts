/*
 * Gotify (PRODUCT.md §6.4, §10): a message to a self-hosted Gotify server through an application
 * token. The body is Markdown, tapping the notification opens the incident, and the priority follows
 * the incident's severity (8 and above makes Android phones sound and vibrate).
 */
import { gotifyChannelConfigSchema, type GotifyChannelConfig } from "@app/shared";
import type { OutboundHttp } from "../../../infra/http/outbound.js";
import type { AlertEvent, ChannelAdapter } from "../types/adapter.js";
import { formConfig } from "./config.js";
import { joinUrl, parseJson, postJson } from "./http.js";
import { renderMarkdownBody, renderPlain } from "./render.js";

/* A malformed message, or a token that was deleted or rotated. */
const PERMANENT = [400, 401, 403, 404];

function priority(event: AlertEvent): number {
  if (event.kind !== "triggered" && event.kind !== "reminder") return 4;
  return { critical: 10, high: 8, low: 5 }[event.incident.severity];
}

export function createGotifyAdapter(deps: {
  http: OutboundHttp;
}): ChannelAdapter<GotifyChannelConfig> {
  return {
    type: "gotify",
    ...formConfig("gotify", gotifyChannelConfigSchema, "Gotify"),
    render(event) {
      const plain = renderPlain(event);
      return {
        ...plain,
        body: {
          title: plain.title,
          message: renderMarkdownBody(event, plain),
          priority: priority(event),
          extras: {
            "client::display": { contentType: "text/markdown" },
            "client::notification": { click: { url: event.incident.url } },
          },
        },
      };
    },
    async send(config, message) {
      const res = await postJson(deps.http, {
        url: joinUrl(config.serverUrl, "/message"),
        headers: { "x-gotify-key": config.appToken },
        body: message.body,
        label: "Gotify",
        permanentStatuses: PERMANENT,
      });
      const id = (parseJson(res.body) as { id?: unknown } | undefined)?.id;
      return { providerRef: typeof id === "number" ? String(id) : undefined };
    },
  };
}
