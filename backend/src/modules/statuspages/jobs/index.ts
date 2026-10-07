/* BullMQ processors for the statuspages module: its event handler queue. */
import type { DbOrTx } from "../../../infra/db/index.js";
import { defineEventProcessor } from "../../../infra/outbox/index.js";
import type { JobProcessor } from "../../../infra/queues/index.js";
import { createStatuspagesEventHandlers } from "../events/index.js";
import type { StatuspagesService } from "../statuspages.service.js";

export function createStatuspagesProcessors(
  service: StatuspagesService,
  db: DbOrTx,
): JobProcessor[] {
  return [
    defineEventProcessor({
      queue: "statuspages-events",
      handler: "statuspages",
      db,
      handlers: createStatuspagesEventHandlers(service),
    }),
  ];
}
