import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createRedis, type RedisClient } from "../../redis.js";
import { createRedisRateLimitStorage } from "../rate-limit-storage.js";
import { DEAD_REDIS_URL, TEST_REDIS_URL } from "../../../__tests__/helpers/test-env.js";

let redis: RedisClient;

beforeAll(() => {
  redis = createRedis(TEST_REDIS_URL);
});

afterAll(async () => {
  await redis.quit();
});

describe("Redis rate-limit storage for Better Auth", () => {
  it("allows up to max requests per window, then reports retryAfter", async () => {
    const storage = createRedisRateLimitStorage(redis, { prefix: `test-rl-${randomUUID()}:` });
    const rule = { window: 10, max: 2 };
    expect(await storage.consume("ip:/sign-in", rule)).toEqual({ allowed: true, retryAfter: null });
    expect(await storage.consume("ip:/sign-in", rule)).toEqual({ allowed: true, retryAfter: null });
    const third = await storage.consume("ip:/sign-in", rule);
    expect(third.allowed).toBe(false);
    expect(third.retryAfter).toBeGreaterThanOrEqual(1);
    expect(third.retryAfter).toBeLessThanOrEqual(10);
    expect((await storage.consume("other-ip:/sign-in", rule)).allowed).toBe(true);
  });

  it("counts concurrent requests atomically", async () => {
    const storage = createRedisRateLimitStorage(redis, { prefix: `test-rl-${randomUUID()}:` });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => storage.consume("burst", { window: 10, max: 5 })),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
  });

  it("resets after the window", async () => {
    const storage = createRedisRateLimitStorage(redis, { prefix: `test-rl-${randomUUID()}:` });
    const rule = { window: 0.2, max: 1 };
    expect((await storage.consume("k", rule)).allowed).toBe(true);
    expect((await storage.consume("k", rule)).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect((await storage.consume("k", rule)).allowed).toBe(true);
  });

  it("fails open when Redis is unreachable", async () => {
    const dead = createRedis(DEAD_REDIS_URL);
    dead.on("error", () => {});
    const errors: unknown[] = [];
    const storage = createRedisRateLimitStorage(dead, { onError: (e) => errors.push(e) });
    expect(await storage.consume("k", { window: 10, max: 1 })).toEqual({
      allowed: true,
      retryAfter: null,
    });
    expect(errors).toHaveLength(1);
    dead.disconnect();
  });
});
