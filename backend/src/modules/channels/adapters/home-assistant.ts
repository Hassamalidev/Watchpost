/*
 * Home Assistant (PRODUCT.md §6.4): fires a webhook trigger, so an automation can flash a light,
 * sound a siren or speak when something goes down. The JSON body is what the automation reads as
 * `trigger.json`: the event, the incident and the monitor, in plain fields.
 */
import { homeAssistantChannelConfigSchema, type HomeAssistantChannelConfig } from "@app/shared";
import type { OutboundHttp } from "../../../infra/http/outbound.js";
import type { ChannelAdapter } from "../types/adapter.js";
import { formConfig } from "./config.js";
import { joinUrl, postJson } from "./http.js";
import { renderPlain } from "./render.js";

/* An unknown webhook ID answers 404 or 405: the automation was deleted or its ID changed. */
const PERMANENT = [400, 401, 403, 404, 405];

export function createHomeAssistantAdapter(deps: {
  http: OutboundHttp;
}): ChannelAdapter<HomeAssistantChannelConfig> {
  return {
    type: "home_assistant",
    ...formConfig("home_assistant", homeAssistantChannelConfigSchema, "Home Assistant"),
    render(event) {
      const plain = renderPlain(event);
      return {
        ...plain,
        body: {
          event: event.kind,
          title: plain.title,
          message: plain.text,
          incident: {
            number: event.incident.number,
            title: event.incident.title,
            severity: event.incident.severity,
            status: event.incident.status,
            url: event.incident.url,
          },
          monitor: event.incident.monitorName,
          workspace: event.workspace.name,
        },
      };
    },
    async send(config, message) {
      await postJson(deps.http, {
        url: joinUrl(config.serverUrl, `/api/webhook/${encodeURIComponent(config.webhookId)}`),
        body: message.body,
        label: "Home Assistant",
        permanentStatuses: PERMANENT,
      });
      return { providerRef: undefined };
    },
  };
}
