/*
 * Sends buffered results in batches (every ~1 s or 100 results, §7.6). A failed send leaves the batch
 * in the buffer and backs off (1 s → 30 s); the API dedupes by result ID, so retries are safe.
 */
import { resultsAcceptedSchema, type CheckResult } from "@app/shared";
import { v7 as uuidv7 } from "uuid";
import type { Logger } from "pino";
import { ApiRejectedError, type ProbeClient } from "../transport/client.js";
import type { ResultBuffer } from "./buffer.js";

export interface Reporter {
  add(result: CheckResult): void;
  /* Sends everything it can right now; resolves when the buffer is empty or the API is unreachable. */
  flush(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  stats(): { buffered: number; sent: number; dropped: number; failures: number };
}

export function createReporter(options: {
  client: ProbeClient;
  buffer: ResultBuffer;
  logger: Logger;
  batchSize?: number;
  flushIntervalMs?: number;
  now?: () => number;
}): Reporter {
  const batchSize = options.batchSize ?? 100;
  const flushIntervalMs = options.flushIntervalMs ?? 1_000;
  const now = options.now ?? Date.now;
  const { buffer, logger } = options;

  let timer: NodeJS.Timeout | undefined;
  let flushing: Promise<void> | undefined;
  let backoffMs = 0;
  let retryAt = 0;
  let sent = 0;
  let dropped = 0;
  let failures = 0;

  async function sendBatches(): Promise<void> {
    const expired = buffer.expire(now());
    if (expired > 0) {
      dropped += expired;
      logger.warn({ dropped: expired }, "dropped results older than the buffer max age");
    }
    while (buffer.size() > 0) {
      if (now() < retryAt) return;
      const batch = buffer.peek(batchSize);
      try {
        await options.client.request("POST", "/results", {
          body: { batchId: uuidv7(), results: batch.map((b) => b.result) },
          schema: resultsAcceptedSchema,
        });
        buffer.ack(new Set(batch.map((b) => b.result.id)));
        sent += batch.length;
        backoffMs = 0;
        retryAt = 0;
      } catch (err) {
        failures += 1;
        if (err instanceof ApiRejectedError && err.status === 400) {
          /* A batch the API will never accept (a probe bug): drop it rather than block the queue. */
          buffer.ack(new Set(batch.map((b) => b.result.id)));
          dropped += batch.length;
          logger.error({ err: err.message }, "API rejected a result batch; dropped it");
          continue;
        }
        backoffMs = Math.min(30_000, backoffMs === 0 ? 1_000 : backoffMs * 2);
        retryAt = now() + backoffMs;
        logger.warn(
          { err: (err as Error).message, buffered: buffer.size(), backoffMs },
          "result upload failed",
        );
        return;
      }
    }
  }

  function flush(): Promise<void> {
    flushing ??= sendBatches().finally(() => {
      flushing = undefined;
    });
    return flushing;
  }

  return {
    add(result) {
      buffer.push(result);
      if (buffer.size() >= batchSize) void flush();
    },
    flush,
    start() {
      timer = setInterval(() => void flush(), flushIntervalMs);
      timer.unref();
    },
    async stop() {
      if (timer !== undefined) clearInterval(timer);
      await flushing;
    },
    stats: () => ({ buffered: buffer.size(), sent, dropped, failures }),
  };
}
