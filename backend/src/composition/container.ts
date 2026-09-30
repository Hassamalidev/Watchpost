/*
 * Composition root (PRODUCT.md §7.3): builds infra clients once, creates modules with explicit
 * dependencies and collects their routers, processors and sweeps. server.ts and worker.ts use it.
 */
import type { AppConfig } from "../config/index.js";
import { systemClock, type Clock } from "../core/clock.js";
import { createTokenCipher } from "../infra/crypto.js";
import { createDb, createDbPool, pingDb } from "../infra/db/index.js";
import { createLocks } from "../infra/locks.js";
import { createLogger, type Logger } from "../infra/logger.js";
import { createOutbox, OUTBOX_MAX_LAG_SECONDS } from "../infra/outbox/index.js";
import { createQueueConnection, createQueues } from "../infra/queues/index.js";
import type { ReadinessCheck } from "../infra/health.js";
import { createRedis, pingRedis } from "../infra/redis.js";
import { createModules } from "./modules.js";
import type { AppModule, Infra, MountedRouter } from "./types.js";

export interface Container {
  infra: Infra;
  modules: AppModule[];
  readinessChecks: Record<string, ReadinessCheck>;
  routers: MountedRouter[];
  rawBodyRouters: MountedRouter[];
  close(): Promise<void>;
}

export function createInfra(
  config: AppConfig,
  options: { service: "api" | "worker"; logger?: Logger; clock?: Clock },
): Infra {
  const logger =
    options.logger ??
    createLogger({
      level: config.logLevel,
      pretty: config.env === "development",
      service: options.service,
    });
  const pool = createDbPool(config.databaseUrl);
  const redis = createRedis(config.redisUrl);
  redis.on("error", (err) => logger.warn({ err: err.message }, "redis connection error"));
  const queueConnection = createQueueConnection(config.redisUrl);
  queueConnection.on("error", (err) =>
    logger.warn({ err: err.message }, "queue redis connection error"),
  );

  return {
    config,
    logger,
    clock: options.clock ?? systemClock,
    pool,
    db: createDb(pool),
    redis,
    queueConnection,
    queues: createQueues(queueConnection),
    outbox: createOutbox(),
    cipher: createTokenCipher(config.encryption),
    locks: createLocks(redis),
  };
}

export function createContainer(
  config: AppConfig,
  options: { service: "api" | "worker"; logger?: Logger; clock?: Clock },
): Container {
  const infra = createInfra(config, options);
  const modules = createModules(infra);

  const readinessChecks: Record<string, ReadinessCheck> = {
    postgres: () => pingDb(infra.pool),
    redis: () => pingRedis(infra.redis),
    outbox: async () => {
      const lag = await infra.outbox.lagSeconds(infra.db);
      if (lag > OUTBOX_MAX_LAG_SECONDS) throw new Error(`outbox lag ${Math.round(lag)} s`);
    },
  };

  return {
    infra,
    modules,
    readinessChecks,
    routers: modules.flatMap((m) => m.routers ?? []),
    rawBodyRouters: modules.flatMap((m) => m.rawBodyRouters ?? []),
    async close() {
      await infra.queues.close().catch(() => {});
      await Promise.allSettled([
        infra.pool.end(),
        infra.redis.quit(),
        infra.queueConnection.quit(),
      ]);
    },
  };
}
