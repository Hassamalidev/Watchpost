/*
 * Redis-backed rate limiting. If Redis is down the limiter lets requests through
 * (PRODUCT.md §13: the UI and ingest keep working without Redis).
 */
import type { Request, RequestHandler, Response } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { RedisStore, type RedisReply } from "rate-limit-redis";
import type { RedisClient } from "../infra/redis.js";
import { RateLimitedError } from "../core/errors.js";

/*
 * The caller's address as a rate-limit key, for limiters that count by address and something else.
 * An IPv6 caller is counted by network, not by single address, which they could change at will.
 */
export const clientIpKey = (req: Request): string => ipKeyGenerator(req.ip ?? "unknown");

export interface RateLimitOptions {
  redis: RedisClient;
  /* Distinct prefix per limiter, for example "ip" or "api-key". */
  name: string;
  windowMs: number;
  limit: number;
  skip?: (path: string) => boolean;
  /* What to count by; the client IP when omitted. */
  keyOf?: (req: Request, res: Response) => string;
}

export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    passOnStoreError: true,
    skip: (req) => options.skip?.(req.path) ?? false,
    ...(options.keyOf ? { keyGenerator: options.keyOf } : {}),
    store: new RedisStore({
      prefix: `rl:${options.name}:`,
      sendCommand: (command: string, ...args: string[]) =>
        options.redis.call(command, ...args) as Promise<RedisReply>,
    }),
    handler: (_req, _res, next) => next(new RateLimitedError()),
  });
}
