/*
 * Composition root (PRODUCT.md §7.3): builds infra clients once, creates modules with explicit
 * dependencies and collects their routers, processors and sweeps. server.ts and worker.ts use it.
 */
import { resolve } from "node:path";
import { Router } from "express";
import { PROBE_API_PREFIX, createAddressPolicy } from "@app/shared";
import type { AppConfig } from "../config/index.js";
import { systemClock, type Clock } from "../core/clock.js";
import { createAuthService, createRedisRateLimitStorage } from "../infra/auth/index.js";
import { createActionLinks } from "../infra/action-links.js";
import { createTokenCipher } from "../infra/crypto.js";
import { createEmailRequester } from "../infra/email/index.js";
import { createDb, createDbPool, pingDb } from "../infra/db/index.js";
import { createOutboundHttp, type OutboundHttp } from "../infra/http/outbound.js";
import { createAnthropicClient, type AiClient } from "../infra/anthropic/index.js";
import { createDnsLookup, type DnsLookup } from "../infra/dns.js";
import { createRevalidator, type Revalidate } from "../infra/revalidate.js";
import { createWebPush } from "../infra/webpush.js";
import { createLocks } from "../infra/locks.js";
import { createLogger, type Logger } from "../infra/logger.js";
import { createOutbox, OUTBOX_MAX_LAG_SECONDS } from "../infra/outbox/index.js";
import { createPaddle, type PaddleApi } from "../infra/paddle/index.js";
import { createFileObjectStore, type ObjectStore } from "../infra/storage/index.js";
import { createR2ObjectStore } from "../infra/storage/r2.js";
import { createQueueConnection, createQueues } from "../infra/queues/index.js";
import type { ReadinessCheck } from "../infra/health.js";
import { createRedis, pingRedis } from "../infra/redis.js";
import { createModules } from "./modules.js";
import { publicApi } from "./public-api.js";
import type { AppModule, Infra, MountedRouter, SecurityEvent } from "./types.js";

export interface Container {
  infra: Infra;
  modules: AppModule[];
  readinessChecks: Record<string, ReadinessCheck>;
  readinessWarnings: Record<string, ReadinessCheck>;
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
  /* Set by the billing module; until then Better Auth's own default applies. */
  memberLimit?: (workspaceId: string) => Promise<number>;
  onSecurityEvent: Array<(event: SecurityEvent) => Promise<void>>;
}

/*
 * /api/probe/v1: probe authentication runs once (it consumes the raw body), then every module's
 * probe routes (probes: hello/assignments/tasks/heartbeat; detection: results).
 */
export function probeApi(modules: AppModule[]): MountedRouter[] {
  const auth = modules.find((m) => m.probeAuth)?.probeAuth;
  const routers = modules.flatMap((m) => m.probeRouters ?? []);
  if (auth === undefined || routers.length === 0) return [];
  const router = Router();
  router.use(...auth, ...routers);
  return [{ path: PROBE_API_PREFIX, router }];
}

export function createInfra(
  config: AppConfig,
  options: {
    service: "api" | "worker";
    logger?: Logger;
    clock?: Clock;
    hooks?: LateHooks;
    /* Tests that sign up many users from one IP turn Better Auth's rate limit off. */
    authRateLimit?: boolean;
    /* Tests replace outbound HTTP (Slack, Telegram, webhooks) with a stub. */
    http?: OutboundHttp;
    /* Tests replace Paddle's API with a fake; webhook signatures are still really verified. */
    paddleApi?: PaddleApi;
    /* Tests keep objects in memory. */
    objects?: ObjectStore;
    /* Tests record which cached pages the web app would be told to drop. */
    revalidate?: Revalidate;
    /* Tests answer DNS themselves. */
    dns?: DnsLookup;
    /* Tests answer for the model. */
    ai?: AiClient;
  },
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
  const hooks = options.hooks ?? { onWorkspaceCreated: [], onSecurityEvent: [] };
  const auth = createAuthService({
    onWorkspaceCreated: async (workspaceId) => {
      for (const hook of hooks.onWorkspaceCreated) await hook(workspaceId);
    },
    memberLimit: (workspaceId) => hooks.memberLimit?.(workspaceId),
    onSecurityEvent: async (event) => {
      for (const hook of hooks.onSecurityEvent) await hook(event);
    },
    db,
    baseURL: config.auth.baseURL,
    secret: config.auth.secret,
    webOrigin: config.webOrigin,
    requestEmail: (template, to, data) => requestEmail(template, to, data),
    rateLimit:
      options.authRateLimit === false
        ? false
        : createRedisRateLimitStorage(redis, {
            onError: (err) =>
              logger.warn({ err }, "auth rate limit storage unavailable; allowing request"),
          }),
    ...(config.auth.turnstileSecretKey
      ? { turnstile: { secretKey: config.auth.turnstileSecretKey } }
      : {}),
  });

  const paddle = config.paddle === undefined ? undefined : createPaddle(config.paddle);
  /* R2 when configured; a local folder while developing; nothing otherwise (evidence is skipped). */
  const objects =
    options.objects ??
    (config.r2 !== undefined
      ? createR2ObjectStore(config.r2)
      : config.env === "development"
        ? createFileObjectStore(resolve(process.cwd(), ".data", "objects"))
        : undefined);

  const http =
    options.http ??
    createOutboundHttp({
      policy: createAddressPolicy({ allowCidrs: config.outbound.allowCidrs }),
    });

  return {
    config,
    logger,
    objects,
    paddle:
      paddle === undefined
        ? undefined
        : { webhooks: paddle.webhooks, api: options.paddleApi ?? paddle.api },
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
    actionLinks: createActionLinks({
      secret: config.auth.secret,
      webOrigin: config.webOrigin,
      clock: options.clock ?? systemClock,
    }),
    http,
    revalidate:
      options.revalidate ?? createRevalidator({ target: config.statusPages.revalidate, logger }),
    dns: options.dns ?? createDnsLookup(),
    ai:
      options.ai ??
      (config.ai === undefined
        ? undefined
        : createAnthropicClient({ apiKey: config.ai.apiKey, model: config.ai.model })),
    webPush:
      config.webPush === undefined
        ? undefined
        : createWebPush({ ...config.webPush, http, clock: options.clock ?? systemClock }),
  };
}

export function createContainer(
  config: AppConfig,
  options: {
    service: "api" | "worker";
    logger?: Logger;
    clock?: Clock;
    authRateLimit?: boolean;
    http?: OutboundHttp;
    paddleApi?: PaddleApi;
    objects?: ObjectStore;
    revalidate?: Revalidate;
    dns?: DnsLookup;
    ai?: AiClient;
  },
): Container {
  const hooks: LateHooks = { onWorkspaceCreated: [], onSecurityEvent: [] };
  const infra = createInfra(config, { ...options, hooks });
  const modules = createModules(infra);
  for (const module of modules) {
    if (module.hooks?.onWorkspaceCreated)
      hooks.onWorkspaceCreated.push(module.hooks.onWorkspaceCreated);
    if (module.hooks?.memberLimit) hooks.memberLimit = module.hooks.memberLimit;
    if (module.hooks?.onSecurityEvent) hooks.onSecurityEvent.push(module.hooks.onSecurityEvent);
  }

  const readinessChecks: Record<string, ReadinessCheck> = {
    postgres: () => pingDb(infra.pool),
    redis: () => pingRedis(infra.redis),
    outbox: async () => {
      const lag = await infra.outbox.lagSeconds(infra.db);
      if (lag > OUTBOX_MAX_LAG_SECONDS) throw new Error(`outbox lag ${Math.round(lag)} s`);
    },
    ...Object.assign({}, ...modules.map((m) => m.readinessChecks ?? {})),
  };
  const readinessWarnings: Record<string, ReadinessCheck> = Object.assign(
    {},
    ...modules.map((m) => m.readinessWarnings ?? {}),
  );

  return {
    infra,
    modules,
    readinessChecks,
    readinessWarnings,
    routers: [
      ...modules.flatMap((m) => m.routers ?? []),
      ...publicApi(modules, { title: "Public API", serverUrl: config.webOrigin }),
    ],
    /* Better Auth and the probe API read the raw request, so they mount before the JSON parser (§7.9 step 3). */
    rawBodyRouters: [
      { path: "/", router: infra.auth.router },
      ...probeApi(modules),
      ...modules.flatMap((m) => m.rawBodyRouters ?? []),
    ],
    async close() {
      await Promise.allSettled(modules.map((m) => m.close?.()));
      await infra.queues.close().catch(() => {});
      await Promise.allSettled([
        infra.pool.end(),
        infra.redis.quit(),
        infra.queueConnection.quit(),
      ]);
    },
  };
}
