/*
 * Microsoft Teams through a Workflows webhook (PRODUCT.md §10, P1): the user creates the "Send
 * webhook alerts to a channel" workflow and pastes its URL; we post an Adaptive Card with an "Open
 * incident" button. Posts appear as the Workflows bot. A deleted or disabled flow answers 404/410,
 * which marks the channel failing so admins hear about it.
 */
import { teamsChannelConfigSchema, type TeamsChannelConfig } from "@app/shared";
import type { OutboundHttp } from "../../../infra/http/outbound.js";
import type { AlertEvent, ChannelAdapter, RenderedMessage } from "../types/adapter.js";
import { formConfig } from "./config.js";
import { call, expectOk } from "./http.js";
import { renderPlain } from "./render.js";

const PERMANENT = [401, 403, 404, 410];

const COLOR = {
  triggered: "attention",
  reminder: "attention",
  flapping: "warning",
  acknowledged: "warning",
  resolved: "good",
  test: "accent",
} as const;

export function adaptiveCard(event: AlertEvent, message: RenderedMessage) {
  const { incident } = event;
  const facts =
    event.kind === "test"
      ? []
      : [
          ...(incident.monitorName ? [{ title: "Monitor", value: incident.monitorName }] : []),
          { title: "Severity", value: incident.severity },
          ...(incident.causeCode ? [{ title: "Cause", value: incident.causeCode }] : []),
          ...(incident.failingRegions.length > 0
            ? [{ title: "Regions", value: incident.failingRegions.join(", ") }]
            : []),
          { title: "Started", value: incident.startedAt },
          ...(event.explanation
            ? [{ title: "Likely cause", value: event.explanation.headline }]
            : []),
          ...(event.explanation?.nextSteps[0]
            ? [{ title: "Check first", value: event.explanation.nextSteps[0] }]
            : []),
        ];
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            {
              type: "TextBlock",
              text: message.title,
              weight: "Bolder",
              size: "Medium",
              wrap: true,
              color: COLOR[event.kind],
            },
            ...(event.kind === "test"
              ? [{ type: "TextBlock", text: message.text, wrap: true }]
              : [{ type: "FactSet", facts }]),
          ],
          actions:
            event.kind === "test"
              ? []
              : [{ type: "Action.OpenUrl", title: "Open incident", url: incident.url }],
        },
      },
    ],
  };
}

export function createTeamsAdapter(deps: {
  http: OutboundHttp;
}): ChannelAdapter<TeamsChannelConfig> {
  return {
    type: "teams",
    ...formConfig("teams", teamsChannelConfigSchema, "Teams"),
    render(event) {
      const plain = renderPlain(event);
      return { ...plain, body: adaptiveCard(event, plain) };
    },
    async send(config, message) {
      const res = await call(
        deps.http,
        {
          method: "POST",
          url: config.url,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(message.body),
        },
        "The Teams workflow",
      );
      expectOk(res, "The Teams workflow", PERMANENT);
      return {};
    },
  };
}
