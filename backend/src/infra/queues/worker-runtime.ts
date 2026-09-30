/*
 * Consumer side: runs recovery sweeps, then one BullMQ Worker per queue that has a processor.
 * `stop()` waits for active jobs to finish (graceful shutdown, STACK.md §5).
 */
import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "../logger.js";
import type { JobProcessor, RecoverySweep } from "./processor.js";
import type { QueueName } from "./registry.js";

export interface WorkerRuntimeOptions {
  connection: Redis;
  logger: Logger;
  processors: JobProcessor[];
  recoverySweeps?: RecoverySweep[];
  /* Subset of queues this process consumes (WORKER_QUEUES); all queues with processors by default. */
  onlyQueues?: readonly QueueName[];
  concurrency?: Partial<Record<QueueName, number>>;
  prefix?: string;
}

export interface WorkerRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly queues: readonly QueueName[];
}

export function createWorkerRuntime(options: WorkerRuntimeOptions): WorkerRuntime {
  const { logger } = options;
  const byQueue = new Map<QueueName, JobProcessor>();
  for (const processor of options.processors) {
    if (byQueue.has(processor.queue)) {
      throw new Error(`Two processors registered for queue "${processor.queue}"`);
    }
    byQueue.set(processor.queue, processor);
  }
  const selected = [...byQueue.keys()].filter(
    (q) => options.onlyQueues === undefined || options.onlyQueues.includes(q),
  );

  const workers: Worker[] = [];
  let stopping: Promise<void> | undefined;

  async function runRecoverySweeps(): Promise<void> {
    for (const sweep of options.recoverySweeps ?? []) {
      try {
        const count = await sweep.run();
        logger.info({ sweep: sweep.name, count }, "recovery sweep finished");
      } catch (err) {
        /* A failed sweep must not block the worker; the next start or periodic sweep retries. */
        logger.error({ sweep: sweep.name, err }, "recovery sweep failed");
      }
    }
  }

  return {
    queues: selected,

    async start() {
      await runRecoverySweeps();
      for (const queue of selected) {
        const processor = byQueue.get(queue);
        if (processor === undefined) continue;
        const worker = new Worker(
          queue,
          async (job) => {
            const jobLogger = logger.child({ queue, jobId: job.id, jobName: job.name });
            return processor.run(job, jobLogger);
          },
          {
            connection: options.connection,
            concurrency: options.concurrency?.[queue] ?? 1,
            ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
          },
        );
        worker.on("failed", (job, err) => {
          logger.warn(
            { queue, jobId: job?.id, attempts: job?.attemptsMade, err: err.message },
            "job failed",
          );
        });
        worker.on("error", (err) => logger.error({ queue, err: err.message }, "worker error"));
        workers.push(worker);
      }
      await Promise.all(workers.map((w) => w.waitUntilReady()));
      logger.info({ queues: selected }, "worker started");
    },

    stop() {
      stopping ??= (async () => {
        logger.info("worker stopping; waiting for active jobs");
        /* close() stops fetching new jobs and resolves once active jobs have finished. */
        await Promise.all(workers.map((w) => w.close()));
        logger.info("worker stopped");
      })();
      return stopping;
    },
  };
}

interface SignalSource {
  once(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  off(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
}

/* Wires SIGTERM/SIGINT to a graceful stop, then exits. `signals` and `exit` are injectable for tests. */
export function installShutdownHandlers(
  stop: () => Promise<void>,
  options: {
    logger: Logger;
    exit?: (code: number) => void;
    forceAfterMs?: number;
    signals?: SignalSource;
  },
): () => void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const forceAfterMs = options.forceAfterMs ?? 60_000;
  const signals = options.signals ?? process;

  const onSignal = (signal: NodeJS.Signals) => {
    options.logger.info({ signal }, "shutdown signal received");
    const force = setTimeout(() => {
      options.logger.error({ forceAfterMs }, "graceful shutdown timed out; exiting");
      exit(1);
    }, forceAfterMs);
    force.unref();
    stop()
      .then(() => exit(0))
      .catch((err: unknown) => {
        options.logger.error({ err }, "error during shutdown");
        exit(1);
      })
      .finally(() => clearTimeout(force));
  };

  signals.once("SIGTERM", onSignal);
  signals.once("SIGINT", onSignal);
  return () => {
    signals.off("SIGTERM", onSignal);
    signals.off("SIGINT", onSignal);
  };
}
