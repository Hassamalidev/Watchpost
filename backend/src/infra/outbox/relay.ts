/*
 * Outbox relay (PRODUCT.md §7.5): wakes on NOTIFY (and polls every second as a fallback), claims up to
 * 100 undispatched rows FOR UPDATE SKIP LOCKED, enqueues one job per subscribed handler with a
 * deterministic ID (evt.{eventId}.{handler}), marks the rows dispatched and commits.
 * A crash between enqueue and commit only re-enqueues the same job IDs, which BullMQ ignores.
 */
import type pg from "pg";
import { isEventType } from "@app/shared";
import type { Db, DbPool } from "../db/index.js";
import type { Logger } from "../logger.js";
import { buildJobId, type Queues } from "../queues/index.js";
import type { QueueName } from "../queues/index.js";
import { OUTBOX_CHANNEL, outboxRepository } from "./outbox.repository.js";

export interface RelaySubscriber {
  handler: string;
  queue: QueueName;
}

export interface EventJobData {
  eventId: string;
  type: string;
  handler: string;
}

export interface OutboxRelayOptions {
  db: Db;
  pool: DbPool;
  queues: Pick<Queues, "enqueue">;
  logger: Logger;
  subscribersOf: (type: string) => readonly RelaySubscriber[];
  batchSize?: number;
  pollIntervalMs?: number;
  /* Test hook: runs after enqueueing and before commit (used to simulate a crash). */
  beforeCommit?: () => Promise<void>;
}

export interface OutboxRelay {
  start(): Promise<void>;
  stop(): Promise<void>;
  /* Dispatches until the outbox is empty; returns the number of rows dispatched. */
  drain(): Promise<number>;
}

export function eventJobId(eventId: string, handler: string): string {
  return buildJobId("evt", eventId, handler);
}

export function createOutboxRelay(options: OutboxRelayOptions): OutboxRelay {
  const { db, logger } = options;
  const batchSize = options.batchSize ?? 100;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;

  let listener: pg.PoolClient | undefined;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<number> | undefined;
  let again = false;
  let stopped = false;

  async function dispatchBatch(): Promise<number> {
    let claimedIds: string[] = [];
    try {
      return await db.transaction(async (tx) => {
        const rows = await outboxRepository.claimBatch(tx, batchSize);
        claimedIds = rows.map((r) => r.id);
        for (const row of rows) {
          if (!isEventType(row.type)) {
            logger.warn(
              { eventId: row.id, type: row.type },
              "outbox event has an unknown type; skipping",
            );
            continue;
          }
          for (const sub of options.subscribersOf(row.type)) {
            const data: EventJobData = { eventId: row.id, type: row.type, handler: sub.handler };
            await options.queues.enqueue(sub.queue, row.type, data, {
              jobId: eventJobId(row.id, sub.handler),
            });
          }
        }
        await options.beforeCommit?.();
        await outboxRepository.markDispatched(tx, claimedIds);
        return rows.length;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message, count: claimedIds.length }, "outbox dispatch failed");
      await outboxRepository.recordFailure(db, claimedIds, message).catch(() => {});
      throw err;
    }
  }

  async function drainLoop(): Promise<number> {
    let total = 0;
    for (;;) {
      const count = await dispatchBatch();
      total += count;
      if (count < batchSize) return total;
    }
  }

  /* Coalesces concurrent wake-ups into one running drain plus at most one follow-up. */
  function drain(): Promise<number> {
    if (running !== undefined) {
      again = true;
      return running;
    }
    running = (async () => {
      let total = 0;
      try {
        do {
          again = false;
          total += await drainLoop();
        } while (again && !stopped);
        return total;
      } finally {
        running = undefined;
      }
    })();
    return running;
  }

  const wake = () => {
    if (stopped) return;
    drain().catch(() => {
      /* Logged in dispatchBatch; the next poll retries. */
    });
  };

  return {
    drain,

    async start() {
      stopped = false;
      listener = await options.pool.connect();
      listener.on("notification", (msg) => {
        if (msg.channel === OUTBOX_CHANNEL) wake();
      });
      await listener.query(`listen ${OUTBOX_CHANNEL}`);
      timer = setInterval(wake, pollIntervalMs);
      wake();
      logger.info({ pollIntervalMs, batchSize }, "outbox relay started");
    },

    async stop() {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      await running?.catch(() => 0);
      if (listener !== undefined) {
        await listener.query(`unlisten ${OUTBOX_CHANNEL}`).catch(() => {});
        listener.release();
        listener = undefined;
      }
      logger.info("outbox relay stopped");
    },
  };
}
