/*
 * Zulip (PRODUCT.md §10): a bot posts to a channel (stream) through the REST API. A Zulip topic is a
 * thread, so by default each monitor gets its own topic and an incident's follow-ups stay together;
 * a fixed topic can be set instead. `type=stream` is used because it works on every Zulip version
 * (`channel` only exists from Zulip 9).
 */
import { zulipChannelConfigSchema, type ZulipChannelConfig } from "@app/shared";
import type { OutboundHttp } from "../../../infra/http/outbound.js";
import { ChannelDeliveryError, type ChannelAdapter } from "../types/adapter.js";
import { formConfig } from "./config.js";
import { call, joinUrl, parseJson } from "./http.js";
import { STATE_EMOJI, renderMarkdownBody, renderPlain, truncate } from "./render.js";

/* Zulip caps topics at 60 characters. */
const TOPIC_MAX = 60;

interface ZulipBody {
  topic: string;
  content: string;
}

export function createZulipAdapter(deps: {
  http: OutboundHttp;
}): ChannelAdapter<ZulipChannelConfig> {
  return {
    type: "zulip",
    ...formConfig("zulip", zulipChannelConfigSchema, "Zulip"),
    render(event) {
      const plain = renderPlain(event);
      const body: ZulipBody = {
        topic: truncate(event.incident.monitorName ?? "Watchpost", TOPIC_MAX),
        content: `${STATE_EMOJI[event.kind]} **${plain.title}**\n${renderMarkdownBody(event, plain)}`,
      };
      return { ...plain, body };
    },
    async send(config, message) {
      const { topic, content } = message.body as ZulipBody;
      const res = await call(
        deps.http,
        {
          method: "POST",
          url: joinUrl(config.serverUrl, "/api/v1/messages"),
          headers: {
            authorization: `Basic ${Buffer.from(`${config.botEmail}:${config.apiKey}`).toString("base64")}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            type: "stream",
            to: config.stream,
            topic: config.topic || topic,
            content,
          }).toString(),
        },
        "Zulip",
      );
      const body = parseJson(res.body) as
        { result?: string; id?: number; msg?: string; code?: string } | undefined;
      if (res.status >= 200 && res.status < 300 && body?.result === "success") {
        return { providerRef: body.id === undefined ? undefined : String(body.id) };
      }
      /* Rate limits and server errors pass; a bad key, bot or channel name needs a person. */
      const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
      throw new ChannelDeliveryError(
        `Zulip refused the message: ${body?.msg ?? `HTTP ${res.status}`}`,
        permanent,
      );
    },
  };
}
