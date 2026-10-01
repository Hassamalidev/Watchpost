/*
 * Opsgenie and Jira Service Management (PRODUCT.md §6.4, §10). Atlassian shuts Opsgenie down on
 * 2027-04-05 and moved its alert API into Jira Service Management with the same key, fields and
 * limits, so one adapter serves both: the `jsm` region only changes the base URL. One Watchpost
 * incident is one alert (the alias): "triggered" creates it, "acknowledged" acknowledges it and
 * "resolved" closes it; reminders re-send the create, which Opsgenie counts on the open alert.
 * "Send test" creates a P5 alert and closes it straight away.
 */
import { opsgenieChannelConfigSchema, type OpsgenieChannelConfig } from "@app/shared";
import type { OutboundHttp } from "../../../infra/http/outbound.js";
import type { AlertEvent, ChannelAdapter } from "../types/adapter.js";
import { formConfig } from "./config.js";
import { postJson } from "./http.js";
import { ONCALL_RETRY, onCallKey } from "./pagerduty.js";
import { renderPlain, truncate } from "./render.js";

export const OPSGENIE_ENDPOINTS = {
  us: "https://api.opsgenie.com/v2/alerts",
  eu: "https://api.eu.opsgenie.com/v2/alerts",
  jsm: "https://api.atlassian.com/jsm/ops/integration/v2/alerts",
} as const;

/* A wrong or disabled key, a plan that doesn't allow the call, or a payload Opsgenie rejects. */
const PERMANENT = [400, 401, 402, 403, 404, 422];
const PRIORITY = { critical: "P1", high: "P2", low: "P4" } as const;

interface OpsgenieBody {
  event: AlertEvent;
  alert: Record<string, unknown>;
}

export function createOpsgenieAdapter(deps: {
  http: OutboundHttp;
}): ChannelAdapter<OpsgenieChannelConfig> {
  return {
    type: "opsgenie",
    retry: ONCALL_RETRY,
    ...formConfig("opsgenie", opsgenieChannelConfigSchema, "Opsgenie"),
    render(event) {
      const plain = renderPlain(event);
      const { incident } = event;
      const body: OpsgenieBody = {
        event,
        alert: {
          message: truncate(plain.title, 130),
          description: truncate(plain.text, 15_000),
          priority: event.kind === "test" ? "P5" : PRIORITY[incident.severity],
          source: "Watchpost",
          ...(incident.monitorName ? { entity: truncate(incident.monitorName, 512) } : {}),
          tags: ["watchpost", incident.severity],
          details: {
            incident: `#${incident.number}`,
            url: incident.url,
            ...(incident.causeCode ? { cause: incident.causeCode } : {}),
            ...(incident.failingRegions.length > 0
              ? { failing_regions: incident.failingRegions.join(", ") }
              : {}),
          },
        },
      };
      return { ...plain, body };
    },
    async send(config, message, meta) {
      const { event, alert } = message.body as OpsgenieBody;
      const alias = onCallKey(event, meta.idempotencyKey);
      const base = OPSGENIE_ENDPOINTS[config.region];
      const post = (path: string, body: Record<string, unknown>) =>
        postJson(deps.http, {
          url: `${base}${path}`,
          body,
          label: "Opsgenie",
          headers: { authorization: `GenieKey ${config.apiKey}` },
          permanentStatuses: PERMANENT,
        });
      const act = (action: "acknowledge" | "close", note: string) =>
        post(`/${encodeURIComponent(alias)}/${action}?identifierType=alias`, {
          source: "Watchpost",
          ...(event.actor ? { user: event.actor } : {}),
          note,
        });

      if (event.kind === "acknowledged") await act("acknowledge", message.title);
      else if (event.kind === "resolved") await act("close", message.title);
      else {
        await post("", { ...alert, alias });
        if (event.kind === "test") await act("close", "Test alert closed by Watchpost.");
      }
      return { providerRef: alias };
    },
  };
}
