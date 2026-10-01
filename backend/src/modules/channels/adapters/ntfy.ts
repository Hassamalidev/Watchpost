/*
 * ntfy (PRODUCT.md §6.4, §10): publishes to a topic on ntfy.sh or a self-hosted server, with a
 * priority from the incident's severity, a tap target and an "Open incident" button. Every message
 * of an incident carries the same sequence ID, so on Android and the web app the notification is
 * replaced by its latest state instead of piling up.
 *
 * ntfy turns messages over 4,096 bytes into attachments and refuses long titles, so both are cut
 * first. A used-up daily quota (error 42908) won't recover by retrying; request-rate limits will.
 */
import { ntfyChannelConfigSchema, type NtfyChannelConfig } from "@app/shared";
import type { OutboundHttp } from "../../../infra/http/outbound.js";
import { ChannelDeliveryError, type AlertEvent, type ChannelAdapter } from "../types/adapter.js";
import { formConfig } from "./config.js";
import { call, parseJson } from "./http.js";
import { plainDetails, renderPlain, truncate, truncateBytes } from "./render.js";

const MESSAGE_MAX_BYTES = 3_800;
const TITLE_MAX = 200;
const DAILY_QUOTA_CODE = 42_908;

const TAG = {
  triggered: "rotating_light",
  reminder: "rotating_light",
  flapping: "warning",
  acknowledged: "eyes",
  resolved: "white_check_mark",
  test: "test_tube",
} as const;

/* ntfy priorities: 5 urgent, 4 high, 3 default. Only a failing monitor is louder than default. */
function priority(event: AlertEvent): number {
  if (event.kind !== "triggered" && event.kind !== "reminder") return 3;
  return { critical: 5, high: 4, low: 3 }[event.incident.severity];
}

export function createNtfyAdapter(deps: { http: OutboundHttp }): ChannelAdapter<NtfyChannelConfig> {
  return {
    type: "ntfy",
    ...formConfig("ntfy", ntfyChannelConfigSchema, "ntfy"),
    render(event) {
      const plain = renderPlain(event);
      return { ...plain, body: event };
    },
    async send(config, message) {
      const event = message.body as AlertEvent;
      const res = await call(
        deps.http,
        {
          method: "POST",
          /* JSON publishing goes to the server root; the topic is in the body. */
          url: config.serverUrl,
          headers: {
            "content-type": "application/json",
            ...(config.accessToken ? { authorization: `Bearer ${config.accessToken}` } : {}),
          },
          body: JSON.stringify({
            topic: config.topic,
            title: truncate(message.title, TITLE_MAX),
            message: truncateBytes(plainDetails(event, message), MESSAGE_MAX_BYTES),
            priority: priority(event),
            tags: [TAG[event.kind]],
            click: event.incident.url,
            actions: [
              {
                action: "view",
                label: event.kind === "test" ? "Open Watchpost" : "Open incident",
                url: event.incident.url,
              },
            ],
            ...(event.kind === "test" ? {} : { sequence_id: `watchpost-${event.incident.id}` }),
          }),
        },
        "ntfy",
      );
      const body = parseJson(res.body) as
        { id?: string; code?: number; error?: string } | undefined;
      if (res.status >= 200 && res.status < 300) {
        return { providerRef: typeof body?.id === "string" ? body.id : undefined };
      }
      const permanent =
        res.status === 429
          ? body?.code === DAILY_QUOTA_CODE
          : res.status >= 400 && res.status < 500;
      throw new ChannelDeliveryError(
        `ntfy refused the message: ${body?.error ?? `HTTP ${res.status}`}`,
        permanent,
      );
    },
  };
}
