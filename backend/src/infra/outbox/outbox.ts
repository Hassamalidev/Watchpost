/*
 * outbox.emit (PRODUCT.md §7.1 rule 6, §7.5): validate the payload against its versioned schema,
 * insert the row in the caller's transaction and NOTIFY the relay (delivered only on commit).
 * If the transaction rolls back, the event never existed.
 */
import { EVENT_SCHEMAS, type EventPayload, type EventType } from "@app/shared";
import type { DbOrTx, Tx } from "../db/index.js";
import { newId } from "../ids.js";
import { outboxRepository } from "./outbox.repository.js";

export interface EmitOptions {
  workspaceId?: string;
  correlationId?: string;
}

export interface Outbox {
  emit<T extends EventType>(
    tx: Tx,
    type: T,
    payload: EventPayload<T>,
    options?: EmitOptions,
  ): Promise<string>;
  lagSeconds(db: DbOrTx): Promise<number>;
  cleanup(db: DbOrTx, olderThanSeconds?: number): Promise<number>;
}

export const OUTBOX_RETENTION_SECONDS = 7 * 24 * 3_600;
export const OUTBOX_MAX_LAG_SECONDS = 60;

export class InvalidEventError extends Error {
  constructor(type: string, detail: string) {
    super(`Invalid payload for event "${type}": ${detail}`);
    this.name = "InvalidEventError";
  }
}

export function createOutbox(): Outbox {
  return {
    async emit(tx, type, payload, options = {}) {
      const definition = EVENT_SCHEMAS[type];
      if (definition === undefined) throw new InvalidEventError(type, "unknown event type");
      const parsed = definition.schema.safeParse(payload);
      if (!parsed.success) throw new InvalidEventError(type, parsed.error.message);

      const id = newId();
      await outboxRepository.insert(tx, {
        id,
        workspaceId: options.workspaceId ?? null,
        type,
        version: definition.version,
        payload: parsed.data,
        correlationId: options.correlationId ?? null,
      });
      await outboxRepository.notify(tx);
      return id;
    },

    lagSeconds: (db) => outboxRepository.lagSeconds(db),

    cleanup: (db, olderThanSeconds = OUTBOX_RETENTION_SECONDS) =>
      outboxRepository.deleteDispatchedOlderThan(db, olderThanSeconds),
  };
}
