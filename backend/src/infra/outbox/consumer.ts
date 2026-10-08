/*
 * Event handler side: a processor for a module's `<module>-events` queue. It reloads the event from
 * Postgres (job data holds IDs only), validates the payload and calls the module's handler.
 * Handlers must be idempotent (rule 9): the same event can arrive twice.
 */
import { UnrecoverableError } from "bullmq";
import { z } from "zod";
import { EVENT_SCHEMAS, isEventType, type EventPayload, type EventType } from "@app/shared";
import type { DbOrTx } from "../db/index.js";
import type { Logger } from "../logger.js";
import { defineProcessor, type JobProcessor, type QueueName } from "../queues/index.js";
import { outboxRepository } from "./outbox.repository.js";

export interface EventMeta {
  eventId: string;
  workspaceId: string | null;
  correlationId: string | null;
  /* When the event was written, which is when it happened. */
  occurredAt: Date;
  logger: Logger;
}

export type EventHandler<T extends EventType> = (
  payload: EventPayload<T>,
  meta: EventMeta,
) => Promise<void>;

export type EventHandlers = { [T in EventType]?: EventHandler<T> };

const eventJobSchema = z.object({ eventId: z.uuid(), type: z.string(), handler: z.string() });

export function defineEventProcessor(options: {
  queue: QueueName;
  handler: string;
  db: DbOrTx;
  handlers: EventHandlers;
}): JobProcessor {
  return defineProcessor({
    queue: options.queue,
    schema: eventJobSchema,
    async handle(data, { logger }) {
      if (data.handler !== options.handler) {
        throw new UnrecoverableError(
          `Job for handler "${data.handler}" reached "${options.handler}"`,
        );
      }
      if (!isEventType(data.type))
        throw new UnrecoverableError(`Unknown event type "${data.type}"`);
      const handle = options.handlers[data.type] as EventHandler<EventType> | undefined;
      if (handle === undefined) {
        throw new UnrecoverableError(`"${options.handler}" has no handler for "${data.type}"`);
      }

      const row = await outboxRepository.findById(options.db, data.eventId);
      if (row === undefined) {
        /* Cleaned up after retention; nothing left to do. */
        logger.warn({ eventId: data.eventId }, "event no longer in the outbox; skipping");
        return;
      }
      const payload = EVENT_SCHEMAS[data.type].schema.parse(row.payload) as EventPayload<EventType>;
      await handle(payload, {
        eventId: row.id,
        workspaceId: row.workspaceId,
        correlationId: row.correlationId,
        occurredAt: row.createdAt,
        logger: logger.child({ eventId: row.id, eventType: row.type }),
      });
    },
  });
}
