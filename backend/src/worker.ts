/*
 * Jobs entry point: build the container, start the outbox relay and every module's processors,
 * run recovery sweeps, register schedules, and stop gracefully on SIGTERM.
 */
import { z } from "zod";
import { ConfigError, loadConfig, type AppConfig } from "./config/index.js";
import { createContainer } from "./composition/container.js";
import { subscribersOf } from "./composition/architecture.js";
import { createOutboxRelay } from "./infra/outbox/index.js";
import { isEventType } from "@app/shared";
import {
  createWorkerRuntime,
  defineProcessor,
  installShutdownHandlers,
  isQueueName,
  type QueueName,
} from "./infra/queues/index.js";

const OUTBOX_CLEANUP_EVERY_MS = 3_600_000;

function fail(message: string): never {
  process.stderr.write(`\n${message}\n\nSee .env.example for every variable.\n\n`);
  process.exit(1);
}

function bootConfig(): AppConfig {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) fail(err.message);
    throw err;
  }
}

function resolveQueues(names: string[] | undefined): QueueName[] | undefined {
  if (names === undefined) return undefined;
  const unknown = names.filter((n) => !isQueueName(n));
  if (unknown.length > 0)
    fail(
      `Invalid environment configuration:\n  - WORKER_QUEUES: unknown queue(s) ${unknown.join(", ")}`,
    );
  return names as QueueName[];
}

const config = bootConfig();
const onlyQueues = resolveQueues(config.workerQueues);
const container = createContainer(config, { service: "worker" });
const { infra, modules } = container;
const { logger } = infra;

const relay = createOutboxRelay({
  db: infra.db,
  pool: infra.pool,
  queues: infra.queues,
  logger: logger.child({ component: "outbox-relay" }),
  subscribersOf: (type) => (isEventType(type) ? subscribersOf(type) : []),
});

/* Platform maintenance on the `sweeps` queue; module sweeps are added in later tasks. */
const platformSweeps = defineProcessor({
  queue: "sweeps",
  schema: z.object({ kind: z.enum(["outbox-cleanup"]) }),
  async handle(data, { logger: jobLogger }) {
    if (data.kind === "outbox-cleanup") {
      const deleted = await infra.outbox.cleanup(infra.db);
      jobLogger.info({ deleted }, "outbox cleanup finished");
    }
  },
});

const runtime = createWorkerRuntime({
  connection: infra.queueConnection,
  logger,
  processors: [platformSweeps, ...modules.flatMap((m) => m.processors ?? [])],
  recoverySweeps: [
    /* Undispatched outbox rows are the source of every event-handler job. */
    { name: "outbox", run: () => relay.drain() },
    ...modules.flatMap((m) => m.recoverySweeps ?? []),
  ],
  ...(onlyQueues === undefined ? {} : { onlyQueues }),
});

installShutdownHandlers(
  async () => {
    await relay.stop();
    await runtime.stop();
    await container.close();
  },
  { logger },
);

await runtime.start();
await relay.start();
await infra.queues
  .get("sweeps")
  .upsertJobScheduler(
    "outbox-cleanup",
    { every: OUTBOX_CLEANUP_EVERY_MS },
    { name: "outbox-cleanup", data: { kind: "outbox-cleanup" } },
  );
