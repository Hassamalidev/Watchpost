/*
 * Composition root (PRODUCT.md §7.3): builds infra clients once, creates modules with explicit
 * dependencies and collects their routers, processors and sweeps. server.ts and worker.ts use it.
 */
import type { AppConfig } from "../config/index.js";
import { systemClock, type Clock } from "../core/clock.js";
import { createAuthService, createRedisRateLimitStorage } from "../infra/auth/index.js";
import { createTokenCipher } from "../infra/crypto.js";
import { createEmailRequester } from "../infra/email/index.js";
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

/*
 * Infra is built before modules, but some infra callbacks (Better Auth hooks) must reach module
 * code. The container passes this object to infra, then fills it after creating the modules.
 */
export interface LateHooks {
  onWorkspaceCreated: Array<(workspaceId: string) => Promise<void>>;
}

export function createInfra(
  config: AppConfig,
  options: { service: "api" | "worker"; logger?: Logger; clock?: Clock; hooks?: LateHooks },
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

  const db = createDb(pool);
  const outbox = createOutbox();
  const requestEmail = createEmailRequester({ db, outbox });
  const hooks = options.hooks ?? { onWorkspaceCreated: [] };
  const auth = createAuthService({
    onWorkspaceCreated: async (workspaceId) => {
      for (const hook of hooks.onWorkspaceCreated) await hook(workspaceId);
    },
    db,
    baseURL: config.auth.baseURL,
    secret: config.auth.secret,
    webOrigin: config.webOrigin,
    requestEmail: (template, to, data) => requestEmail(template, to, data),
    rateLimit: createRedisRateLimitStorage(redis, {
      onError: (err) =>
        logger.warn({ err }, "auth rate limit storage unavailable; allowing request"),
    }),
    ...(config.auth.turnstileSecretKey
      ? { turnstile: { secretKey: config.auth.turnstileSecretKey } }
      : {}),
  });

  return {
    config,
    logger,
    clock: options.clock ?? systemClock,
    pool,
    db,
    redis,
    queueConnection,
    queues: createQueues(queueConnection),
    outbox,
    cipher: createTokenCipher(config.encryption),
    locks: createLocks(redis),
    auth,
    requestEmail,
  };
}

export function createContainer(
  config: AppConfig,
  options: { service: "api" | "worker"; logger?: Logger; clock?: Clock },
): Container {
  const hooks: LateHooks = { onWorkspaceCreated: [] };
  const infra = createInfra(config, { ...options, hooks });
  const modules = createModules(infra);
  for (const module of modules) {
    if (module.hooks?.onWorkspaceCreated)
      hooks.onWorkspaceCreated.push(module.hooks.onWorkspaceCreated);
  }

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
    /* Better Auth reads the raw request, so it mounts before the JSON parser (§7.9 step 3). */
    rawBodyRouters: [
      { path: "/", router: infra.auth.router },
      ...modules.flatMap((m) => m.rawBodyRouters ?? []),
    ],
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
