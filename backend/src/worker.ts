/*
 * Jobs entry point: build the container, start the outbox relay and every module's processors,
 * run recovery sweeps, register schedules, and stop gracefully on SIGTERM.
 */
import { z } from "zod";
import { ConfigError, loadConfig, type AppConfig } from "./config/index.js";
import { createContainer } from "./composition/container.js";
import { subscribersOf } from "./composition/architecture.js";
import { createOutboxRelay } from "./infra/outbox/index.js";
import {
  createConsoleTransport,
  createEmailProcessor,
  createMemoryTransport,
  createResendTransport,
} from "./infra/email/index.js";
import { isEventType } from "@app/shared";
import { UnrecoverableError } from "bullmq";
import type { ModuleSweep } from "./composition/types.js";
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

/* The shared `sweeps` queue: platform maintenance plus every module's sweeps, dispatched by kind. */
const sweeps = new Map<string, ModuleSweep>([
  [
    "outbox-cleanup",
    {
      kind: "outbox-cleanup",
      everyMs: OUTBOX_CLEANUP_EVERY_MS,
      async run(jobLogger) {
        const deleted = await infra.outbox.cleanup(infra.db);
        jobLogger.info({ deleted }, "outbox cleanup finished");
      },
    },
  ],
]);
for (const sweep of modules.flatMap((m) => m.sweeps ?? [])) {
  if (sweeps.has(sweep.kind)) fail(`Two sweeps registered with kind "${sweep.kind}"`);
  sweeps.set(sweep.kind, sweep);
}
const platformSweeps = defineProcessor({
  queue: "sweeps",
  schema: z.object({ kind: z.string() }),
  async handle(data, { logger: jobLogger }) {
    const sweep = sweeps.get(data.kind);
    if (sweep === undefined) throw new UnrecoverableError(`Unknown sweep "${data.kind}"`);
    await sweep.run(jobLogger);
  },
});

/* email.requested → rendered and sent (console in development, Resend in production). */
const emails = createEmailProcessor({
  db: infra.db,
  transport:
    config.email.transport === "resend" && config.email.resendApiKey
      ? createResendTransport({ apiKey: config.email.resendApiKey })
      : config.email.transport === "memory"
        ? createMemoryTransport()
        : createConsoleTransport(logger.child({ component: "email" })),
  from: config.email.from,
  logger,
});

const runtime = createWorkerRuntime({
  connection: infra.queueConnection,
  logger,
  processors: [platformSweeps, emails, ...modules.flatMap((m) => m.processors ?? [])],
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

/* Repeating jobs: platform cleanup plus every module's schedules (idempotent on each start). */
const schedules = [
  ...[...sweeps.values()].map((sweep) => ({
    queue: "sweeps" as const,
    id: sweep.kind === "outbox-cleanup" ? "outbox-cleanup" : `sweep-${sweep.kind}`,
    everyMs: sweep.everyMs,
    data: { kind: sweep.kind },
  })),
  ...modules.flatMap((m) => m.schedules ?? []),
];
for (const schedule of schedules) {
  await infra.queues
    .get(schedule.queue)
    .upsertJobScheduler(
      schedule.id,
      { every: schedule.everyMs },
      { name: schedule.id, data: schedule.data },
    );
}
