/*
 * PagerDuty through the Events API v2 (PRODUCT.md §6.4, §10). One Watchpost incident is one PagerDuty
 * alert: every event carries the same dedup key, so "triggered" opens it, "acknowledged" acknowledges
 * it and "resolved" resolves it. Reminders and flapping notices re-send the trigger, which PagerDuty
 * adds to the open alert (or, if someone resolved it there while the incident is still open here,
 * opens it again). "Send test" opens a low-severity alert and resolves it straight away.
 */
import { pagerDutyChannelConfigSchema, type PagerDutyChannelConfig } from "@app/shared";
import type { OutboundHttp } from "../../../infra/http/outbound.js";
import type { AlertEvent, ChannelAdapter } from "../types/adapter.js";
import { formConfig } from "./config.js";
import { postJson } from "./http.js";
import { renderPlain, truncate } from "./render.js";

export const PAGERDUTY_ENDPOINTS = {
  us: "https://events.pagerduty.com/v2/enqueue",
  eu: "https://events.eu.pagerduty.com/v2/enqueue",
} as const;

/* A malformed event or an unknown integration key; throttling (429) and 5xx are retried. */
const PERMANENT = [400, 401, 403, 404];
/* Pages matter more than chat messages: keep trying for about 20 minutes. */
export const ONCALL_RETRY = { attempts: 8, backoffMs: 10_000 } as const;

const SEVERITY = { critical: "critical", high: "error", low: "warning" } as const;
const ACTION = {
  triggered: "trigger",
  reminder: "trigger",
  flapping: "trigger",
  acknowledged: "acknowledge",
  resolved: "resolve",
  test: "trigger",
} as const;

/* Stable per incident; tests get their own key so they never touch a real alert. */
export const onCallKey = (event: AlertEvent, idempotencyKey: string) =>
  event.kind === "test" ? `watchpost-test-${idempotencyKey}` : `watchpost-${event.incident.id}`;

interface PagerDutyBody {
  event: AlertEvent;
  action: (typeof ACTION)[AlertEvent["kind"]];
  payload: Record<string, unknown>;
}

export function createPagerDutyAdapter(deps: {
  http: OutboundHttp;
}): ChannelAdapter<PagerDutyChannelConfig> {
  return {
    type: "pagerduty",
    retry: ONCALL_RETRY,
    ...formConfig("pagerduty", pagerDutyChannelConfigSchema, "PagerDuty"),
    render(event) {
      const plain = renderPlain(event);
      const { incident } = event;
      const body: PagerDutyBody = {
        event,
        action: ACTION[event.kind],
        payload: {
          summary: truncate(plain.title, 1_024),
          source: incident.monitorName ?? event.workspace.name,
          severity: event.kind === "test" ? "info" : SEVERITY[incident.severity],
          timestamp: incident.startedAt,
          group: event.workspace.name,
          ...(incident.causeCode ? { class: incident.causeCode } : {}),
          custom_details: {
            incident: `#${incident.number} ${incident.title}`,
            failing_regions: incident.failingRegions,
            ...(event.explanation
              ? {
                  likely_cause: event.explanation.headline,
                  check_first: event.explanation.nextSteps[0] ?? null,
                }
              : {}),
          },
        },
      };
      return { ...plain, body };
    },
    async send(config, message, meta) {
      const { event, action, payload } = message.body as PagerDutyBody;
      const dedupKey = onCallKey(event, meta.idempotencyKey);
      const post = (body: Record<string, unknown>) =>
        postJson(deps.http, {
          url: PAGERDUTY_ENDPOINTS[config.region],
          body: { routing_key: config.routingKey, dedup_key: dedupKey, ...body },
          label: "PagerDuty",
          permanentStatuses: PERMANENT,
        });

      if (action === "trigger") {
        await post({
          event_action: "trigger",
          payload,
          client: "Watchpost",
          client_url: event.incident.url,
          links: [{ href: event.incident.url, text: "Open in Watchpost" }],
        });
        if (event.kind === "test") await post({ event_action: "resolve" });
      } else {
        await post({ event_action: action });
      }
      return { providerRef: dedupKey };
    },
  };
}
