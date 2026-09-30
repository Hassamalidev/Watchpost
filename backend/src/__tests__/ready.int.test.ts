/* /api/ready against real Postgres and Redis, and against unreachable ones. */
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pino } from "pino";
import { createApp } from "../app.js";
import { createDbPool, pingDb, type DbPool } from "../infra/db.js";
import { createRedis, pingRedis, type RedisClient } from "../infra/redis.js";
import {
  DEAD_DATABASE_URL,
  DEAD_REDIS_URL,
  TEST_DATABASE_URL,
  TEST_REDIS_URL,
} from "./helpers/test-env.js";

const opened: Array<{ db: DbPool; redis: RedisClient }> = [];

function buildApp(databaseUrl: string, redisUrl: string) {
  const db = createDbPool(databaseUrl, { max: 1 });
  const redis = createRedis(redisUrl);
  redis.on("error", () => {});
  opened.push({ db, redis });
  return createApp({
    config: { webOrigin: "http://localhost:3000", api: { port: 0, trustProxy: "loopback" } },
    logger: pino({ level: "silent" }),
    redis,
    readinessChecks: { postgres: () => pingDb(db), redis: () => pingRedis(redis) },
  });
}

afterAll(async () => {
  for (const { db, redis } of opened) {
    await db.end().catch(() => {});
    redis.disconnect();
  }
});

describe("/api/ready with real dependencies", () => {
  it("is ready when Postgres and Redis are up", async () => {
    const res = await request(buildApp(TEST_DATABASE_URL, TEST_REDIS_URL)).get("/api/ready");
    expect(res.status).toBe(200);
    expect(res.body.checks).toMatchObject({ postgres: { ok: true }, redis: { ok: true } });
  });

  it("is not ready when Postgres is unreachable", async () => {
    const res = await request(buildApp(DEAD_DATABASE_URL, TEST_REDIS_URL)).get("/api/ready");
    expect(res.status).toBe(503);
    expect(res.body.checks).toMatchObject({ postgres: { ok: false }, redis: { ok: true } });
  });

  it("is not ready when Redis is unreachable", async () => {
    const res = await request(buildApp(TEST_DATABASE_URL, DEAD_REDIS_URL)).get("/api/ready");
    expect(res.status).toBe(503);
    expect(res.body.checks).toMatchObject({ postgres: { ok: true }, redis: { ok: false } });
  });
});
