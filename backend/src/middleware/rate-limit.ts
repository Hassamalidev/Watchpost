/*
 * Redis-backed rate limiting. If Redis is down the limiter lets requests through
 * (PRODUCT.md §13: the UI and ingest keep working without Redis).
 */
import type { RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { RedisStore, type RedisReply } from "rate-limit-redis";
import type { RedisClient } from "../infra/redis.js";
import { RateLimitedError } from "../core/errors.js";

export interface RateLimitOptions {
  redis: RedisClient;
  /* Distinct prefix per limiter, for example "ip" or "api-key". */
  name: string;
  windowMs: number;
  limit: number;
  skip?: (path: string) => boolean;
}

export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    passOnStoreError: true,
    skip: (req) => options.skip?.(req.path) ?? false,
    store: new RedisStore({
      prefix: `rl:${options.name}:`,
      sendCommand: (command: string, ...args: string[]) =>
        options.redis.call(command, ...args) as Promise<RedisReply>,
    }),
    handler: (_req, _res, next) => next(new RateLimitedError()),
  });
}
