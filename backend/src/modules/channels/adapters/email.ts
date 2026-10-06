/*
 * Email channel (§6.4, §10): alert emails go through the transactional email pipeline (outbox →
 * `emails` queue → transport) with the `alert` template. Each recipient gets their own email with
 * signed, single-use action links bound to them (acknowledge while triggered, resolve while open)
 * and a stable idempotency key, so a retried delivery never sends twice.
 */
import { emailChannelConfigSchema, type EmailChannelConfig } from "@app/shared";
import type { ActionLinks } from "../../../infra/action-links.js";
import type { RequestEmail } from "../../../infra/email/index.js";
import type { AlertEvent, ChannelAdapter } from "../types/adapter.js";
import { parseConfigWith } from "./config.js";
import { renderPlain } from "./render.js";

export function createEmailAdapter(deps: {
  requestEmail: RequestEmail;
  actionLinks?: ActionLinks | undefined;
}): ChannelAdapter<EmailChannelConfig> {
  function links(event: AlertEvent, recipient: string) {
    const { incident } = event;
    if (deps.actionLinks === undefined || event.kind === "test" || incident.status === "resolved") {
      return {};
    }
    const make = (action: "acknowledge" | "resolve") =>
      deps.actionLinks!.url({
        workspaceId: event.workspace.id,
        incidentId: incident.id,
        action,
        recipient,
      });
    return {
      ...(incident.status === "triggered" ? { acknowledge: make("acknowledge") } : {}),
      resolve: make("resolve"),
    };
  }

  return {
    type: "email",
    parseConfig: (input) => parseConfigWith(emailChannelConfigSchema, input, "Email"),
    render(event) {
      return { ...renderPlain(event), body: event };
    },
    async send(config, message, meta) {
      const event = message.body as AlertEvent;
      for (const to of config.to) {
        await deps.requestEmail(
          "alert",
          to,
          {
            kind: event.kind,
            subject: message.title,
            workspaceName: event.workspace.name,
            incident: {
              number: event.incident.number,
              title: event.incident.title,
              severity: event.incident.severity,
              causeCode: event.incident.causeCode,
              failingRegions: event.incident.failingRegions,
              monitorName: event.incident.monitorName,
              startedAt: event.incident.startedAt,
              durationSeconds: event.incident.durationSeconds,
              url: event.incident.url,
            },
            actor: event.actor,
            explanation: event.explanation,
            actions: links(event, to),
          },
          { workspaceId: event.workspace.id, idempotencyKey: `${meta.idempotencyKey}:${to}` },
        );
      }
      return { providerRef: `email:${meta.idempotencyKey}` };
    },
  };
}
