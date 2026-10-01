/*
 * Splunk On-Call (formerly VictorOps) through its REST endpoint (PRODUCT.md §6.4, §10). One Watchpost
 * incident is one entity: CRITICAL (or WARNING for low severity) opens it, ACKNOWLEDGEMENT and
 * RECOVERY follow. "Send test" is an INFO message, which shows on the timeline without paging.
 */
import { splunkOnCallChannelConfigSchema, type SplunkOnCallChannelConfig } from "@app/shared";
import type { OutboundHttp } from "../../../infra/http/outbound.js";
import { ChannelDeliveryError, type AlertEvent, type ChannelAdapter } from "../types/adapter.js";
import { formConfig } from "./config.js";
import { parseJson, postJson } from "./http.js";
import { ONCALL_RETRY, onCallKey } from "./pagerduty.js";
import { renderPlain, truncate } from "./render.js";

/* A wrong API key or routing key. The docs name no status codes, so everything else is retried. */
const PERMANENT = [401, 403, 404];

function messageType(event: AlertEvent): string {
  switch (event.kind) {
    case "test":
      return "INFO";
    case "acknowledged":
      return "ACKNOWLEDGEMENT";
    case "resolved":
      return "RECOVERY";
    default:
      return event.incident.severity === "low" ? "WARNING" : "CRITICAL";
  }
}

export function createSplunkOnCallAdapter(deps: {
  http: OutboundHttp;
}): ChannelAdapter<SplunkOnCallChannelConfig> {
  return {
    type: "splunk_oncall",
    retry: ONCALL_RETRY,
    ...formConfig("splunk_oncall", splunkOnCallChannelConfigSchema, "Splunk On-Call"),
    render(event) {
      const plain = renderPlain(event);
      return { ...plain, body: event };
    },
    async send(config, message, meta) {
      const event = message.body as AlertEvent;
      const entityId = onCallKey(event, meta.idempotencyKey);
      const res = await postJson(deps.http, {
        url: config.url,
        body: {
          message_type: messageType(event),
          entity_id: entityId,
          entity_display_name: truncate(message.title, 1_000),
          state_message: truncate(message.text, 20_000),
          monitoring_tool: "Watchpost",
          "vo_annotate.u.Incident": event.incident.url,
        },
        label: "Splunk On-Call",
        permanentStatuses: PERMANENT,
      });
      const body = parseJson(res.body) as { result?: string; message?: string } | undefined;
      if (body?.result === "failure") {
        /* The endpoint accepted the request but not the alert; the same alert would fail again. */
        throw new ChannelDeliveryError(
          `Splunk On-Call refused the alert: ${body.message ?? "no reason given"}`,
          true,
        );
      }
      return { providerRef: entityId };
    },
  };
}
