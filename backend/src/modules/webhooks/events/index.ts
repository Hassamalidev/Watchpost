/*
 * Handlers for the events the webhooks module passes on (the `webhooks-events` queue, §7.5). Each
 * reloads what the event is about and publishes it in the public shape; the internal payload never
 * leaves as it is.
 */
import type { V1Incident, WebhookEventType } from "@app/shared";
import { NotFoundError } from "../../../core/errors.js";
import { createWorkspaceScope } from "../../../core/workspace-scope.js";
import type { EventHandlers, EventMeta } from "../../../infra/outbox/index.js";
import type { IncidentsService } from "../../incidents/index.js";
import type { MonitorsService } from "../../monitors/index.js";
import type { WebhooksService } from "../webhooks.service.js";

export function createWebhooksEventHandlers(deps: {
  service: WebhooksService;
  incidents: Pick<IncidentsService, "get">;
  monitors: Pick<MonitorsService, "getForDetection">;
  webOrigin: string;
}): EventHandlers {
  async function monitorOf(id: string | null | undefined) {
    if (id === null || id === undefined) return null;
    const [monitor] = await deps.monitors.getForDetection([id]);
    return monitor === undefined
      ? null
      : { id: monitor.id, name: monitor.name, type: monitor.type };
  }

  const publish = (meta: EventMeta, type: WebhookEventType, data: Record<string, unknown>) =>
    meta.workspaceId === null
      ? Promise.resolve(0)
      : deps.service.publish({
          workspaceId: meta.workspaceId,
          eventKey: meta.eventId,
          type,
          occurredAt: meta.occurredAt,
          data,
        });

  const incident =
    (type: WebhookEventType) =>
    async ({ incidentId }: { incidentId: string }, meta: EventMeta) => {
      if (meta.workspaceId === null) return;
      const scope = createWorkspaceScope({ workspaceId: meta.workspaceId });
      let found;
      try {
        found = await deps.incidents.get(scope, incidentId);
      } catch (err) {
        /* Deleted with its workspace before we got here. */
        if (err instanceof NotFoundError) return;
        throw err;
      }
      const view: V1Incident & { url: string } = {
        id: found.id,
        number: found.number,
        title: found.title,
        status: found.status,
        severity: found.severity,
        source: found.source,
        monitorId: found.monitorId,
        causeCode: found.causeCode,
        failingRegions: found.failingRegions,
        startedAt: found.startedAt,
        acknowledgedAt: found.acknowledgedAt,
        resolvedAt: found.resolvedAt,
        durationSeconds: found.durationSeconds,
        url: `${deps.webOrigin}/w/${meta.workspaceId}/incidents/${found.number}`,
      };
      await publish(meta, type, { incident: view, monitor: await monitorOf(found.monitorId) });
    };

  const monitor =
    (type: "monitor.created" | "monitor.updated") =>
    async ({ monitorId, name }: { monitorId: string; name: string }, meta: EventMeta) => {
      await publish(meta, type, {
        monitor: (await monitorOf(monitorId)) ?? { id: monitorId, name },
      });
    };

  return {
    "incident.triggered": incident("incident.triggered"),
    "incident.acknowledged": incident("incident.acknowledged"),
    "incident.resolved": incident("incident.resolved"),
    "incident.reopened": incident("incident.reopened"),
    "monitor.created": monitor("monitor.created"),
    "monitor.updated": monitor("monitor.updated"),
    "monitor.deleted": async ({ monitorId }, meta) => {
      await publish(meta, "monitor.deleted", { monitor: { id: monitorId } });
    },
    "monitor.state_changed": async ({ monitorId, from, to, at }, meta) => {
      await publish(meta, "monitor.state_changed", {
        monitor: (await monitorOf(monitorId)) ?? { id: monitorId },
        from,
        to,
        at,
      });
    },
    "status_page.update_published": async (payload, meta) => {
      await publish(meta, "status_page.update_published", { ...payload });
    },
  };
}
