/* BullMQ processors for the ai module: its event handler queue. */
import type { DbOrTx } from "../../../infra/db/index.js";
import { defineEventProcessor } from "../../../infra/outbox/index.js";
import type { JobProcessor } from "../../../infra/queues/index.js";
import { createAiEventHandlers } from "../events/index.js";

export function createAiProcessors(db: DbOrTx): JobProcessor[] {
  return [
    defineEventProcessor({
      queue: "ai-events",
      handler: "ai",
      db,
      handlers: createAiEventHandlers(),
    }),
  ];
}
