/*
 * Jobs entry point: load config, build infra, register processors and recovery sweeps, run until SIGTERM.
 * Processors and sweeps are added by modules through the composition root (P0-T09).
 */
import { ConfigError, loadConfig, type AppConfig } from "./config/index.js";
import { createLogger } from "./infra/logger.js";
import { createDbPool } from "./infra/db/index.js";
import {
  createQueueConnection,
  createWorkerRuntime,
  installShutdownHandlers,
  isQueueName,
  type JobProcessor,
  type QueueName,
  type RecoverySweep,
} from "./infra/queues/index.js";

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
const logger = createLogger({
  level: config.logLevel,
  pretty: config.env === "development",
  service: "worker",
});
const db = createDbPool(config.databaseUrl);
const connection = createQueueConnection(config.redisUrl);
connection.on("error", (err) => logger.warn({ err: err.message }, "redis connection error"));

const processors: JobProcessor[] = [];
const recoverySweeps: RecoverySweep[] = [];

const runtime = createWorkerRuntime({
  connection,
  logger,
  processors,
  recoverySweeps,
  ...(onlyQueues === undefined ? {} : { onlyQueues }),
});

installShutdownHandlers(
  async () => {
    await runtime.stop();
    await Promise.allSettled([db.end(), connection.quit()]);
  },
  { logger },
);

await runtime.start();
