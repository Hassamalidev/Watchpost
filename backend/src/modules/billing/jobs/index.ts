/*
 * BullMQ processors for the billing module: its event handler queue and `billing`, which applies one
 * stored Paddle event per job (`paddle.{eventId}`; job data holds the ID only).
 */
import { z } from "zod";
import type { DbOrTx } from "../../../infra/db/index.js";
import { defineEventProcessor, type EventHandlers } from "../../../infra/outbox/index.js";
import { defineProcessor, type JobProcessor } from "../../../infra/queues/index.js";
import type { PaddleSync } from "../paddle-sync.js";

export function createBillingProcessors(deps: {
  db: DbOrTx;
  handlers: EventHandlers;
  sync: Pick<PaddleSync, "process">;
}): JobProcessor[] {
  return [
    defineEventProcessor({
      queue: "billing-events",
      handler: "billing",
      db: deps.db,
      handlers: deps.handlers,
    }),
    defineProcessor({
      queue: "billing",
      schema: z.object({ eventId: z.string().min(1).max(200) }),
      async handle({ eventId }, { logger }) {
        const outcome = await deps.sync.process(eventId);
        logger.info({ eventId, outcome }, "Paddle event processed");
        return outcome;
      },
    }),
  ];
}
