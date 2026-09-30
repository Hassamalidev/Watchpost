/* Shapes shared by the composition root and every module factory (PRODUCT.md §7.3). */
import type { Router } from "express";
import type { Redis } from "ioredis";
import type { AppConfig } from "../config/index.js";
import type { Clock } from "../core/clock.js";
import type { TokenCipher } from "../infra/crypto.js";
import type { Db, DbPool } from "../infra/db/index.js";
import type { Locks } from "../infra/locks.js";
import type { Logger } from "../infra/logger.js";
import type { Outbox } from "../infra/outbox/index.js";
import type { JobProcessor, Queues, RecoverySweep } from "../infra/queues/index.js";
import type { RedisClient } from "../infra/redis.js";
import type { ModuleName } from "./architecture.js";

/* Infrastructure built once per process and handed to modules explicitly (no DI container). */
export interface Infra {
  config: AppConfig;
  logger: Logger;
  clock: Clock;
  pool: DbPool;
  db: Db;
  /* For rate limits and locks; fails fast when Redis is down. */
  redis: RedisClient;
  /* For BullMQ (blocking commands need their own connection settings). */
  queueConnection: Redis;
  queues: Queues;
  outbox: Outbox;
  cipher: TokenCipher;
  locks: Locks;
}

export interface MountedRouter {
  path: string;
  router: Router;
}

/* What a module factory returns. Everything except `name` is optional. */
export interface AppModule {
  name: ModuleName;
  /* JSON API routes, mounted after the JSON parser. */
  routers?: MountedRouter[];
  /* Webhook, probe and token-URL routes that need the raw body. */
  rawBodyRouters?: MountedRouter[];
  /* BullMQ processors for this module's own queues and its `<module>-events` queue. */
  processors?: JobProcessor[];
  recoverySweeps?: RecoverySweep[];
}
