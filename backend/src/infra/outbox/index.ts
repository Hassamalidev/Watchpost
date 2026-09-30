/* Transactional outbox (PRODUCT.md §7.5). "Emit X" always means outbox.emit(tx, X, payload). */
export { outboxEvents, type OutboxEventRow } from "./schema.js";
export {
  createOutbox,
  InvalidEventError,
  OUTBOX_MAX_LAG_SECONDS,
  OUTBOX_RETENTION_SECONDS,
  type EmitOptions,
  type Outbox,
} from "./outbox.js";
export {
  createOutboxRelay,
  eventJobId,
  type EventJobData,
  type OutboxRelay,
  type RelaySubscriber,
} from "./relay.js";
export {
  defineEventProcessor,
  type EventHandler,
  type EventHandlers,
  type EventMeta,
} from "./consumer.js";
