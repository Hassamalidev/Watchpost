/*
 * Event catalog (PRODUCT.md §7.5). Every event has a versioned payload schema; outbox.emit validates
 * against it before inserting. Payloads carry IDs and a short summary; handlers reload state.
 * To change a payload incompatibly, add a new version instead of editing the old one.
 */
import { z } from "zod";
import { MONITOR_STATUSES } from "../constants/product.js";
import { SEVERITIES } from "../constants/regions.js";

const id = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const severity = z.enum(SEVERITIES);

export const EVENT_SCHEMAS = {
  "workspace.created": { version: 1, schema: z.object({ workspaceId: id }) },
  "monitor.created": { version: 1, schema: z.object({ monitorId: id, name: z.string() }) },
  "monitor.updated": { version: 1, schema: z.object({ monitorId: id, name: z.string() }) },
  "monitor.deleted": { version: 1, schema: z.object({ monitorId: id }) },
  "monitor.state_changed": {
    version: 1,
    schema: z.object({
      monitorId: id,
      from: z.enum(MONITOR_STATUSES),
      to: z.enum(MONITOR_STATUSES),
      at: timestamp,
    }),
  },
  "incident.triggered": {
    version: 1,
    schema: z.object({
      incidentId: id,
      number: z.number().int().positive(),
      monitorId: id.optional(),
      severity,
      title: z.string(),
    }),
  },
  "incident.acknowledged": {
    version: 1,
    schema: z.object({ incidentId: id, byUserId: id.optional(), via: z.string().optional() }),
  },
  "incident.snoozed": { version: 1, schema: z.object({ incidentId: id, until: timestamp }) },
  "incident.resolved": { version: 1, schema: z.object({ incidentId: id, auto: z.boolean() }) },
  "incident.reopened": { version: 1, schema: z.object({ incidentId: id }) },
  "incident.escalation_requested": { version: 1, schema: z.object({ incidentId: id }) },
  /* An open incident changed in a way worth telling people (for example a nearer expiry date). */
  "incident.updated": {
    version: 1,
    schema: z.object({ incidentId: id, reason: z.string().max(300) }),
  },
  /* 5+ state changes in 30 minutes: one notice, then quiet until stable (§9.2). */
  "incident.flapping_started": { version: 1, schema: z.object({ incidentId: id }) },
  "incident.ai_summary_ready": {
    version: 1,
    schema: z.object({ incidentId: id, generationId: id }),
  },
  "incident.false_alarm_marked": { version: 1, schema: z.object({ incidentId: id }) },
  "channel.health_changed": {
    version: 1,
    schema: z.object({ channelId: id, status: z.enum(["healthy", "failing"]) }),
  },
  "status_page.update_published": {
    version: 1,
    schema: z.object({ statusPageId: id, statusIncidentId: id, updateId: id }),
  },
  "billing.plan_changed": {
    version: 1,
    schema: z.object({ from: z.string(), to: z.string() }),
  },
  "billing.period_renewed": {
    version: 1,
    schema: z.object({ subscriptionId: id, periodEnd: timestamp }),
  },
  "import.completed": { version: 1, schema: z.object({ importId: id, source: z.string() }) },
  "email.requested": {
    version: 1,
    schema: z.object({
      template: z.string(),
      to: z.email(),
      data: z.record(z.string(), z.unknown()),
      /* Stable key for the provider when the same email may be requested twice (alert retries). */
      idempotencyKey: z.string().min(1).max(200).optional(),
      /* Extra email headers, for example List-Unsubscribe on digests. */
      headers: z.record(z.string(), z.string().max(2_000)).optional(),
    }),
  },
} as const;

export type EventType = keyof typeof EVENT_SCHEMAS;

export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_SCHEMAS)[T]["schema"]>;

export const EVENT_TYPES = Object.keys(EVENT_SCHEMAS) as EventType[];

export function isEventType(value: string): value is EventType {
  return Object.hasOwn(EVENT_SCHEMAS, value);
}
