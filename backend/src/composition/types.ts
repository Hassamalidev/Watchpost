/* Shapes shared by the composition root and every module factory (PRODUCT.md §7.3). */
import type { RequestHandler, Router } from "express";
import type { Redis } from "ioredis";
import type { AppConfig } from "../config/index.js";
import type { Clock } from "../core/clock.js";
import type { ActionLinks } from "../infra/action-links.js";
import type { AuthService } from "../infra/auth/index.js";
import type { TokenCipher } from "../infra/crypto.js";
import type { RequestEmail } from "../infra/email/index.js";
import type { Db, DbPool } from "../infra/db/index.js";
import type { OutboundHttp } from "../infra/http/outbound.js";
import type { Locks } from "../infra/locks.js";
import type { Logger } from "../infra/logger.js";
import type { Outbox } from "../infra/outbox/index.js";
import type { PaddleClient } from "../infra/paddle/index.js";
import type { JobProcessor, QueueName, Queues, RecoverySweep } from "../infra/queues/index.js";
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
  auth: AuthService;
  /* Emits email.requested in its own transaction; the worker's `emails` queue sends it. */
  requestEmail: RequestEmail;
  /* SSRF-safe HTTP for URLs users give us (webhooks, chat APIs). */
  http: OutboundHttp;
  /* Signed single-use action links for alert emails. */
  actionLinks: ActionLinks;
  /* Paddle Billing; undefined until the owner adds keys. */
  paddle: PaddleClient | undefined;
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
  /* Repeating jobs the worker registers on start (re-registering is idempotent). */
  schedules?: ModuleSchedule[];
  /* Periodic work on the shared `sweeps` queue; the worker dispatches by `kind`. */
  sweeps?: ModuleSweep[];
  /* Intervals the API process runs (for example the platform tick). Failures are logged. */
  apiTimers?: ApiTimer[];
  /* Probe protocol routes (/api/probe/v1/*); the container mounts them behind probe auth. */
  probeRouters?: Router[];
  /* Probe authentication middleware (raw body + HMAC); provided by the probes module only. */
  probeAuth?: RequestHandler[];
  /* Releases resources (listeners, connections) on shutdown. */
  close?: () => Promise<void>;
  /* Callbacks from infrastructure that can't depend on modules (for example Better Auth hooks). */
  hooks?: AppHooks;
}

export interface ModuleSchedule {
  queue: QueueName;
  /* Stable scheduler ID; the same ID updates the existing schedule. */
  id: string;
  everyMs: number;
  data: Record<string, unknown>;
}

export interface ModuleSweep {
  /* Unique across modules; also the scheduler ID (`sweep-<kind>`). */
  kind: string;
  everyMs: number;
  run(logger: Logger): Promise<void>;
}

export interface ApiTimer {
  name: string;
  everyMs: number;
  run(): Promise<void>;
}

export interface AppHooks {
  /* After Better Auth creates an organization (workspace). Must be idempotent. */
  onWorkspaceCreated?: (workspaceId: string) => Promise<void>;
  /* How many members the workspace's plan allows (Better Auth asks before adding one). */
  memberLimit?: (workspaceId: string) => Promise<number>;
}
