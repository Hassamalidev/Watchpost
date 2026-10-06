/*
 * Better Auth rate-limit storage in Redis (Redis holds only jobs, locks and rate limits).
 * `consume` is atomic (one Lua call), so concurrent requests cannot all pass a stale read.
 * If Redis is unavailable the request is allowed, matching the API's fail-open limits (D-020).
 */
import type { RedisClient } from "../redis.js";

const CONSUME_SCRIPT = `
local count = redis.call("incr", KEYS[1])
if count == 1 then
  redis.call("pexpire", KEYS[1], ARGV[1])
end
if count > tonumber(ARGV[2]) then
  return {0, redis.call("pttl", KEYS[1])}
end
return {1, -1}`;

export interface RateLimitDecision {
  allowed: boolean;
  retryAfter: number | null;
}

export function createRedisRateLimitStorage(
  redis: RedisClient,
  options: { prefix?: string; onError?: (err: unknown) => void } = {},
) {
  const prefix = options.prefix ?? "rl:auth:";
  return {
    async consume(key: string, rule: { window: number; max: number }): Promise<RateLimitDecision> {
      try {
        const [allowed, ttlMs] = (await redis.eval(
          CONSUME_SCRIPT,
          1,
          `${prefix}${key}`,
          String(Math.max(1, Math.round(rule.window * 1_000))),
          String(rule.max),
        )) as [number, number];
        if (allowed === 1) return { allowed: true, retryAfter: null };
        return { allowed: false, retryAfter: Math.max(1, Math.ceil(ttlMs / 1_000)) };
      } catch (err) {
        options.onError?.(err);
        return { allowed: true, retryAfter: null };
      }
    },
  };
}
