/* BullMQ processors for the credits module: its event handler queue. */
import type { DbOrTx } from "../../../infra/db/index.js";
import { defineEventProcessor } from "../../../infra/outbox/index.js";
import type { JobProcessor } from "../../../infra/queues/index.js";
import type { CreditsService } from "../credits.service.js";
import { createCreditsEventHandlers } from "../events/index.js";

export function createCreditsProcessors(service: CreditsService, db: DbOrTx): JobProcessor[] {
  return [
    defineEventProcessor({
      queue: "credits-events",
      handler: "credits",
      db,
      handlers: createCreditsEventHandlers(service),
    }),
  ];
}
