/* Redis locks against real Redis, isolated by a unique prefix. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { createLocks, type Locks } from "../locks.js";
import { TEST_REDIS_URL } from "../../__tests__/helpers/test-env.js";

let redis: Redis;
let locks: Locks;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(() => {
  redis = new Redis(TEST_REDIS_URL);
  locks = createLocks(redis, { prefix: `test-lock-${randomUUID()}:` });
});

afterAll(async () => {
  await redis.quit();
});

describe("locks", () => {
  it("gives the lock to one holder at a time", async () => {
    const a = await locks.acquire("monitor-1", 5_000);
    const b = await locks.acquire("monitor-1", 5_000);
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(await a?.release()).toBe(true);
    const c = await locks.acquire("monitor-1", 5_000);
    expect(c).not.toBeNull();
    await c?.release();
  });

  it("lets only the owner release or extend", async () => {
    const a = await locks.acquire("monitor-2", 100);
    expect(a).not.toBeNull();
    await sleep(150);
    const b = await locks.acquire("monitor-2", 5_000);
    expect(b).not.toBeNull();
    /* a expired and b owns it now: a's release and extend must not touch b's lock */
    expect(await a?.release()).toBe(false);
    expect(await a?.extend(5_000)).toBe(false);
    expect(await locks.acquire("monitor-2", 5_000)).toBeNull();
    await b?.release();
  });

  it("extends the TTL for the owner", async () => {
    const a = await locks.acquire("monitor-3", 150);
    expect(await a?.extend(2_000)).toBe(true);
    await sleep(250);
    expect(await locks.acquire("monitor-3", 1_000)).toBeNull();
    await a?.release();
  });

  it("withLock runs once for concurrent callers and always releases", async () => {
    let runs = 0;
    const work = () =>
      locks.withLock("sweep", 5_000, async () => {
        runs += 1;
        await sleep(100);
        return "done";
      });
    const results = await Promise.all([work(), work(), work()]);
    expect(runs).toBe(1);
    expect(results.filter((r) => r.acquired)).toEqual([{ acquired: true, value: "done" }]);

    await expect(
      locks.withLock("sweep", 5_000, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await locks.acquire("sweep", 1_000)).not.toBeNull();
  });

  it("rejects invalid TTLs", async () => {
    await expect(locks.acquire("x", 0)).rejects.toThrow(/TTL/);
  });
});
