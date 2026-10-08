/* BullMQ processors for the webhooks module: its event handler queue. */
import type { DbOrTx } from "../../../infra/db/index.js";
import { defineEventProcessor, type EventHandlers } from "../../../infra/outbox/index.js";
import type { JobProcessor } from "../../../infra/queues/index.js";

export function createWebhooksProcessors(handlers: EventHandlers, db: DbOrTx): JobProcessor[] {
  return [defineEventProcessor({ queue: "webhooks-events", handler: "webhooks", db, handlers })];
}
