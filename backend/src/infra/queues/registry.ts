/*
 * Every BullMQ queue in the system (PRODUCT.md §7.5). A queue must declare how its jobs are
 * rebuilt after a crash: from Postgres by a recovery sweep, from re-registered schedules,
 * or not at all (`ephemeral`). Architecture tests (P0-T09) check this list.
 */
export const QUEUE_NAMES = [
  "evaluate",
  "alerting-events",
  "statuspages-events",
  "ai-events",
  "credits-events",
  "billing-events",
  "monitors-events",
  "admin-events",
  "notify",
  "escalate",
  "timers",
  "sweeps",
  "results",
  "statuspages",
  "ai",
  "reports",
  "imports",
  "billing",
  "emails",
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export type QueueKind =
  "technical" | "event-handler" | "follow-up" | "delayed" | "scheduled" | "on-demand";

export type QueueRecovery =
  /* A recovery sweep rebuilds pending jobs from Postgres on start. */
  | { mode: "sweep"; source: string }
  /* Repeatable schedules are re-registered on start; each run is idempotent. */
  | { mode: "schedules" }
  /* Losing a job is acceptable (for example, AI is optional). */
  | { mode: "ephemeral"; reason: string };

export interface QueueDefinition {
  kind: QueueKind;
  recovery: QueueRecovery;
}

const fromOutbox: QueueDefinition = {
  kind: "event-handler",
  recovery: { mode: "sweep", source: "undispatched outbox rows" },
};

export const QUEUES: Record<QueueName, QueueDefinition> = {
  evaluate: {
    kind: "technical",
    recovery: { mode: "sweep", source: "monitor_state.last_result_at > last_evaluated_at" },
  },
  "alerting-events": fromOutbox,
  "statuspages-events": fromOutbox,
  "ai-events": fromOutbox,
  "credits-events": fromOutbox,
  "billing-events": fromOutbox,
  "monitors-events": fromOutbox,
  "admin-events": fromOutbox,
  notify: {
    kind: "follow-up",
    recovery: { mode: "sweep", source: "pending notification_deliveries" },
  },
  escalate: {
    kind: "delayed",
    recovery: {
      mode: "sweep",
      source: "triggered incidents: esc_round, esc_step and the last timeline event",
    },
  },
  timers: {
    kind: "delayed",
    recovery: { mode: "sweep", source: "snoozed_until, monitor_state.since, last reminder event" },
  },
  sweeps: { kind: "scheduled", recovery: { mode: "schedules" } },
  results: { kind: "scheduled", recovery: { mode: "schedules" } },
  statuspages: {
    kind: "follow-up",
    recovery: { mode: "sweep", source: "unsent subscriber fan-out rows" },
  },
  ai: { kind: "follow-up", recovery: { mode: "ephemeral", reason: "AI is optional" } },
  reports: { kind: "scheduled", recovery: { mode: "schedules" } },
  imports: { kind: "on-demand", recovery: { mode: "sweep", source: "imports.status" } },
  billing: { kind: "follow-up", recovery: { mode: "sweep", source: "unprocessed billing_events" } },
  emails: fromOutbox,
};

export function isQueueName(value: string): value is QueueName {
  return (QUEUE_NAMES as readonly string[]).includes(value);
}
