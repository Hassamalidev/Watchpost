/*
 * Redis locks (Redis holds only jobs, locks and rate limits). A lock is a key with a random owner
 * token and a TTL; only the owner can extend or release it. Locks are an optimization against
 * duplicate work, never the source of correctness: Postgres constraints and row locks are.
 */
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0`;

const EXTEND_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0`;

export interface Lock {
  key: string;
  token: string;
  release(): Promise<boolean>;
  extend(ttlMs: number): Promise<boolean>;
}

export interface Locks {
  acquire(name: string, ttlMs: number): Promise<Lock | null>;
  /* Runs `fn` while holding the lock; returns `{ acquired: false }` if someone else holds it. */
  withLock<T>(
    name: string,
    ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<{ acquired: true; value: T } | { acquired: false }>;
}

export function createLocks(redis: Redis, options: { prefix?: string } = {}): Locks {
  const prefix = options.prefix ?? "lock:";

  const acquire: Locks["acquire"] = async (name, ttlMs) => {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0)
      throw new Error("Lock TTL must be a positive integer");
    const key = `${prefix}${name}`;
    const token = randomUUID();
    const ok = await redis.set(key, token, "PX", ttlMs, "NX");
    if (ok !== "OK") return null;
    return {
      key,
      token,
      release: async () => (await redis.eval(RELEASE_SCRIPT, 1, key, token)) === 1,
      extend: async (ms) => (await redis.eval(EXTEND_SCRIPT, 1, key, token, String(ms))) === 1,
    };
  };

  return {
    acquire,
    async withLock(name, ttlMs, fn) {
      const lock = await acquire(name, ttlMs);
      if (lock === null) return { acquired: false };
      try {
        return { acquired: true, value: await fn() };
      } finally {
        await lock.release();
      }
    },
  };
}
