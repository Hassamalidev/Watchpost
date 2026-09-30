/*
 * The architecture contract in code (PRODUCT.md §7.4–7.5):
 * - which modules exist and which modules each may call (from module-edges.json, also read by
 *   .dependency-cruiser.cjs so CI enforces exactly this graph);
 * - which handler queues consume which events (the §7.5 event catalog).
 * Change PRODUCT.md §7.4/§7.5 in the same commit as this file.
 */
import edges from "./module-edges.json" with { type: "json" };
import { EVENT_TYPES, type EventType } from "@app/shared";
import type { QueueName } from "../infra/queues/index.js";

export type ModuleName = keyof typeof edges.modules;

export const MODULE_NAMES = Object.keys(edges.modules) as ModuleName[];

/* "*" means read-only access to every module (admin). */
export const ALLOWED_CALLS: Readonly<Record<ModuleName, readonly (ModuleName | "*")[]>> =
  edges.modules as Record<ModuleName, (ModuleName | "*")[]>;

export function mayCall(from: ModuleName, to: ModuleName): boolean {
  if (from === to) return true;
  const allowed = ALLOWED_CALLS[from];
  return allowed.includes("*") || allowed.includes(to);
}

/*
 * Event subscriptions: the outbox relay enqueues one job per (event, subscriber) on the
 * subscriber's queue. `noConsumer` marks events deliberately without a consumer yet.
 */
export interface EventSubscriber {
  handler: string;
  queue: QueueName;
}

export const EVENT_SUBSCRIPTIONS: Readonly<
  Record<EventType, readonly EventSubscriber[] | "noConsumer">
> = {
  "workspace.created": [
    { handler: "alerting", queue: "alerting-events" },
    { handler: "admin", queue: "admin-events" },
  ],
  "monitor.created": [
    { handler: "statuspages", queue: "statuspages-events" },
    { handler: "admin", queue: "admin-events" },
  ],
  "monitor.updated": [
    { handler: "statuspages", queue: "statuspages-events" },
    { handler: "admin", queue: "admin-events" },
  ],
  "monitor.deleted": [
    { handler: "statuspages", queue: "statuspages-events" },
    { handler: "admin", queue: "admin-events" },
  ],
  "monitor.state_changed": [
    { handler: "statuspages", queue: "statuspages-events" },
    { handler: "admin", queue: "admin-events" },
  ],
  "incident.triggered": [
    { handler: "alerting", queue: "alerting-events" },
    { handler: "ai", queue: "ai-events" },
    { handler: "statuspages", queue: "statuspages-events" },
    { handler: "admin", queue: "admin-events" },
  ],
  "incident.acknowledged": [
    { handler: "alerting", queue: "alerting-events" },
    { handler: "statuspages", queue: "statuspages-events" },
  ],
  "incident.snoozed": [
    { handler: "alerting", queue: "alerting-events" },
    { handler: "statuspages", queue: "statuspages-events" },
  ],
  "incident.resolved": [
    { handler: "alerting", queue: "alerting-events" },
    { handler: "statuspages", queue: "statuspages-events" },
  ],
  "incident.reopened": [
    { handler: "alerting", queue: "alerting-events" },
    { handler: "statuspages", queue: "statuspages-events" },
  ],
  "incident.escalation_requested": [{ handler: "alerting", queue: "alerting-events" }],
  "incident.flapping_started": [{ handler: "alerting", queue: "alerting-events" }],
  "incident.updated": [{ handler: "alerting", queue: "alerting-events" }],
  "incident.ai_summary_ready": [{ handler: "alerting", queue: "alerting-events" }],
  "incident.false_alarm_marked": [
    { handler: "alerting", queue: "alerting-events" },
    { handler: "admin", queue: "admin-events" },
  ],
  "channel.health_changed": [{ handler: "alerting", queue: "alerting-events" }],
  "status_page.update_published": [{ handler: "statuspages", queue: "statuspages-events" }],
  "billing.plan_changed": [
    { handler: "monitors", queue: "monitors-events" },
    { handler: "credits", queue: "credits-events" },
    { handler: "admin", queue: "admin-events" },
  ],
  "billing.period_renewed": [{ handler: "credits", queue: "credits-events" }],
  "import.completed": [{ handler: "admin", queue: "admin-events" }],
  "email.requested": [{ handler: "email", queue: "emails" }],
};

export function subscribersOf(type: EventType): readonly EventSubscriber[] {
  const subs = EVENT_SUBSCRIPTIONS[type];
  return subs === "noConsumer" ? [] : subs;
}

export { EVENT_TYPES };
