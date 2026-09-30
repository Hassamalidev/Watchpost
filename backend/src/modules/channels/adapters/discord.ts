/*
 * Discord (PRODUCT.md §10): a channel webhook URL; one embed per alert, colored by state and linking
 * to the incident. Webhooks can't reply in threads, so follow-ups are new messages and the first
 * message's embed is edited to the latest state.
 */
import { discordChannelConfigSchema, type DiscordChannelConfig } from "@app/shared";
import { ValidationError } from "../../../core/errors.js";
import type { OutboundHttp } from "../../../infra/http/outbound.js";
import type { AlertEvent, ChannelAdapter, RenderedMessage } from "../types/adapter.js";
import { STATE_COLORS, call, expectOk, parseJson } from "./http.js";
import { renderPlain } from "./render.js";

/* A deleted webhook (404) or a bad token (401) won't come back by retrying. */
const PERMANENT = [401, 403, 404];

function embed(event: AlertEvent, message: RenderedMessage) {
  const { incident } = event;
  if (event.kind === "test") {
    return { title: message.title, description: message.text, color: STATE_COLORS.test };
  }
  const fields = [
    ...(incident.monitorName
      ? [{ name: "Monitor", value: incident.monitorName, inline: true }]
      : []),
    { name: "Severity", value: incident.severity, inline: true },
    ...(incident.causeCode ? [{ name: "Cause", value: incident.causeCode, inline: true }] : []),
    ...(incident.failingRegions.length > 0
      ? [{ name: "Regions", value: incident.failingRegions.join(", "), inline: true }]
      : []),
  ];
  return {
    title: message.title.slice(0, 256),
    url: incident.url,
    color: STATE_COLORS[event.kind],
    fields,
    timestamp: event.at,
  };
}

export function createDiscordAdapter(deps: {
  http: OutboundHttp;
}): ChannelAdapter<DiscordChannelConfig> {
  return {
    type: "discord",
    parseConfig(input) {
      const parsed = discordChannelConfigSchema.safeParse(input);
      if (!parsed.success)
        throw new ValidationError(`Invalid Discord webhook: ${parsed.error.message}`);
      return parsed.data;
    },
    render(event) {
      const plain = renderPlain(event);
      return { ...plain, body: { username: "Watchpost", embeds: [embed(event, plain)] } };
    },
    async send(config, message) {
      const res = await call(
        deps.http,
        {
          method: "POST",
          url: `${config.url}?wait=true`,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(message.body),
        },
        "Discord",
      );
      expectOk(res, "Discord", PERMANENT);
      const id = (parseJson(res.body) as { id?: unknown } | undefined)?.id;
      return { providerRef: typeof id === "string" ? id : undefined };
    },
    async update(config, ref, message) {
      const res = await call(
        deps.http,
        {
          method: "PATCH",
          url: `${config.url}/messages/${encodeURIComponent(ref)}`,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ embeds: (message.body as { embeds: unknown[] }).embeds }),
        },
        "Discord",
      );
      expectOk(res, "Discord", PERMANENT);
    },
  };
}
