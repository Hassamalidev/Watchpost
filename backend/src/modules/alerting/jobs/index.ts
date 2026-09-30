/*
 * BullMQ processors for the alerting module: its event handler queue, `notify` (one send attempt per
 * job; RetryDeliveryError makes BullMQ retry with backoff) and `timers` (reminders). Alerting is the
 * only module with timers so far; when another module needs them, the processor dispatches by kind.
 */
import { z } from "zod";
import type { DbOrTx } from "../../../infra/db/index.js";
import { defineEventProcessor } from "../../../infra/outbox/index.js";
import { defineProcessor, type JobProcessor } from "../../../infra/queues/index.js";
import type { AlertingService } from "../alerting.service.js";
import { createAlertingEventHandlers } from "../events/index.js";

export function createAlertingProcessors(service: AlertingService, db: DbOrTx): JobProcessor[] {
  return [
    defineEventProcessor({
      queue: "alerting-events",
      handler: "alerting",
      db,
      handlers: createAlertingEventHandlers(service),
    }),
    defineProcessor({
      queue: "notify",
      schema: z.object({ deliveryId: z.uuid() }),
      async handle({ deliveryId }, { logger }) {
        const outcome = await service.deliver(deliveryId);
        logger.info({ deliveryId, outcome }, "delivery attempt finished");
        return outcome;
      },
    }),
    defineProcessor({
      queue: "timers",
      schema: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("reminder"),
          incidentId: z.uuid(),
          dueAt: z.number().int().positive(),
        }),
      ]),
      async handle(job, { logger }) {
        const planned = await service.reminderDue(job.incidentId, job.dueAt);
        logger.info({ incidentId: job.incidentId, planned }, "reminder processed");
      },
    }),
  ];
}
