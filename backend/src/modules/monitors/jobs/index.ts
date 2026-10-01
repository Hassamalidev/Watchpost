/* BullMQ processors for the monitors module: its event handler queue. */
import type { DbOrTx } from "../../../infra/db/index.js";
import { defineEventProcessor } from "../../../infra/outbox/index.js";
import type { JobProcessor } from "../../../infra/queues/index.js";
import { createMonitorsEventHandlers } from "../events/index.js";
import type { MonitorsService } from "../monitors.service.js";

export function createMonitorsProcessors(service: MonitorsService, db: DbOrTx): JobProcessor[] {
  return [
    defineEventProcessor({
      queue: "monitors-events",
      handler: "monitors",
      db,
      handlers: createMonitorsEventHandlers(service),
    }),
  ];
}
