/* Handlers for events the alerting module consumes (the `alerting-events` queue, §7.5). */
import type { EventHandlers } from "../../../infra/outbox/index.js";
import { createWorkspaceScope } from "../../../core/workspace-scope.js";
import type { CreditsService } from "../../credits/index.js";
import type { AlertingService } from "../alerting.service.js";

export function createAlertingEventHandlers(
  service: AlertingService,
  credits?: Pick<CreditsService, "refundIncident">,
): EventHandlers {
  /* Handled by later tasks (snooze, escalation, AI follow-ups). */
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
      const escalating = await service.startEscalation(incidentId);
      meta.logger.info({ incidentId, planned, escalating }, "alert deliveries planned");
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
    /* An update to an open incident (a nearer expiry) goes out like a reminder. */
    "incident.updated": async ({ incidentId }, meta) => {
      await service.planIncidentEvent({ kind: "reminder", incidentId, eventKey: meta.eventId });
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
    /* A false alarm gives back the SMS and voice credits its alerts used (§5). */
    "incident.false_alarm_marked": async ({ incidentId }, meta) => {
      if (credits === undefined || meta.workspaceId === null) return;
      const refunded = await credits.refundIncident(
        createWorkspaceScope({ workspaceId: meta.workspaceId }),
        incidentId,
      );
      if (refunded > 0) meta.logger.info({ incidentId, refunded }, "false-alarm credits refunded");
    },
  };
}
