/* Handlers for events the statuspages module consumes (the `statuspages-events` queue, §7.5). */
import type { EventHandlers } from "../../../infra/outbox/index.js";
import type { StatuspagesService } from "../statuspages.service.js";

export function createStatuspagesEventHandlers(service: StatuspagesService): EventHandlers {
  /* Internal incidents change no page by themselves; the monitor's state does. */
  const nothing = async () => undefined;
  return {
    "monitor.state_changed": async ({ monitorId, to }, meta) => {
      const pages = await service.onMonitorChanged(monitorId);
      if (pages > 0) meta.logger.info({ monitorId, to, pages }, "status pages refreshed");
    },
    "monitor.deleted": async ({ monitorId }, meta) => {
      const unlinked = await service.onMonitorDeleted(monitorId);
      if (unlinked > 0) meta.logger.info({ monitorId, unlinked }, "status components unlinked");
    },
    "status_page.update_published": async ({ statusPageId }) => {
      await service.onUpdatePublished(statusPageId);
    },
    "monitor.created": nothing,
    "monitor.updated": nothing,
    "incident.triggered": nothing,
    "incident.acknowledged": nothing,
    "incident.snoozed": nothing,
    "incident.resolved": nothing,
    "incident.reopened": nothing,
  };
}
