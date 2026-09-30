/* Handlers for events the alerting module consumes (the `alerting-events` queue, §7.5). */
import type { EventHandlers } from "../../../infra/outbox/index.js";
import type { AlertingService } from "../alerting.service.js";

export function createAlertingEventHandlers(service: AlertingService): EventHandlers {
  /* Handled by later tasks (snooze, escalation, AI follow-ups, credit refunds). */
  const later = async () => undefined;
  return {
    "workspace.created": async ({ workspaceId }) => {
      await service.ensureDefaultPolicy(workspaceId);
    },
    "incident.triggered": async ({ incidentId }, meta) => {
      const planned = await service.planIncidentEvent({
        kind: "triggered",
        incidentId,
        eventKey: meta.eventId,
      });
      await service.scheduleReminders(incidentId);
      meta.logger.info({ incidentId, planned }, "alert deliveries planned");
    },
    "incident.acknowledged": async ({ incidentId, byUserId }, meta) => {
      await service.planIncidentEvent({
        kind: "acknowledged",
        incidentId,
        eventKey: meta.eventId,
        actorUserId: byUserId,
      });
    },
    "incident.resolved": async ({ incidentId }, meta) => {
      await service.planIncidentEvent({ kind: "resolved", incidentId, eventKey: meta.eventId });
    },
    "incident.flapping_started": async ({ incidentId }, meta) => {
      await service.planIncidentEvent({ kind: "flapping", incidentId, eventKey: meta.eventId });
    },
    "channel.health_changed": async ({ channelId, status }) => {
      await service.onChannelHealth(channelId, status);
    },
    "incident.snoozed": later,
    "incident.reopened": later,
    "incident.escalation_requested": later,
    "incident.ai_summary_ready": later,
    "incident.false_alarm_marked": later,
  };
}
