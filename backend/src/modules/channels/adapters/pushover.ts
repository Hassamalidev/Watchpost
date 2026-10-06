/*
 * Pushover (PRODUCT.md §6.4, §10): push notifications to a user or group key through the customer's
 * own Pushover application. High and critical incidents bypass quiet hours; in `emergency` mode a
 * critical incident repeats every minute for up to an hour until someone acknowledges it, and
 * acknowledging or resolving the incident here cancels the repeats (by tag).
 *
 * Pushover asks senders not to repeat requests it refused: every 4xx is permanent, including 429,
 * which is the monthly quota, and too many refused requests get the sending IP blocked.
 */
import { pushoverChannelConfigSchema, type PushoverChannelConfig } from "@app/shared";
import type { OutboundHttp } from "../../../infra/http/outbound.js";
import { ChannelDeliveryError, type AlertEvent, type ChannelAdapter } from "../types/adapter.js";
import { formConfig } from "./config.js";
import { call, parseJson } from "./http.js";
import { plainDetails, renderPlain, truncate } from "./render.js";

export const PUSHOVER_API = "https://api.pushover.net/1";
const EMERGENCY = { retry: 60, expire: 3_600 } as const;

const incidentTag = (event: AlertEvent) => `watchpost-${event.incident.id}`;

function priority(event: AlertEvent, config: PushoverChannelConfig): number {
  if (event.kind !== "triggered" && event.kind !== "reminder") return 0;
  if (event.incident.severity === "low") return 0;
  return event.incident.severity === "critical" && config.critical === "emergency" ? 2 : 1;
}

export function createPushoverAdapter(deps: {
  http: OutboundHttp;
}): ChannelAdapter<PushoverChannelConfig> {
  async function post(path: string, payload: Record<string, unknown>) {
    const res = await call(
      deps.http,
      {
        method: "POST",
        url: `${PUSHOVER_API}${path}`,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
      "Pushover",
    );
    const body = parseJson(res.body) as { status?: number; errors?: string[] } | undefined;
    if (res.status >= 200 && res.status < 300 && body?.status === 1) return;
    const reason = body?.errors?.join("; ") || `HTTP ${res.status}`;
    throw new ChannelDeliveryError(
      `Pushover refused the message: ${reason}`,
      res.status >= 400 && res.status < 500,
    );
  }

  return {
    type: "pushover",
    ...formConfig("pushover", pushoverChannelConfigSchema, "Pushover"),
    render(event) {
      const plain = renderPlain(event);
      return { ...plain, body: event };
    },
    async send(config, message) {
      const event = message.body as AlertEvent;
      const { incident } = event;
      /* Stop an emergency alert's repeats once the incident is handled. Best effort. */
      if (
        config.critical === "emergency" &&
        (event.kind === "acknowledged" || event.kind === "resolved")
      ) {
        await post(`/receipts/cancel_by_tag/${encodeURIComponent(incidentTag(event))}.json`, {
          token: config.appToken,
        }).catch(() => undefined);
      }

      const level = priority(event, config);
      await post("/messages.json", {
        token: config.appToken,
        user: config.userKey,
        title: truncate(message.title, 250),
        message: truncate(plainDetails(event, message), 1_024),
        url: incident.url,
        url_title: event.kind === "test" ? "Open Watchpost" : "Open incident",
        priority: level,
        timestamp: Math.floor(Date.parse(event.at) / 1_000),
        ...(level === 2 ? { ...EMERGENCY, tags: incidentTag(event) } : {}),
      });
      return {};
    },
  };
}
