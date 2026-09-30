import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { Router } from "express";
import { pino } from "pino";
import { problemSchema } from "@app/shared";
import { createApp } from "../app.js";
import { createRedis, type RedisClient } from "../infra/redis.js";
import { ConflictError } from "../core/errors.js";
import { isUuidV7 } from "../infra/ids.js";
import { randomIp, TEST_REDIS_URL } from "./helpers/test-env.js";

const WEB_ORIGIN = "http://localhost:3000";
let redis: RedisClient;

function buildApp(options: { ready?: boolean; limit?: number } = {}) {
  const demo = Router();
  demo.get("/conflict", () => {
    throw new ConflictError("Already exists.");
  });
  demo.get("/boom", () => {
    throw new Error("secret internal detail");
  });
  demo.post("/echo", (req, res) => {
    res.json(req.body);
  });

  return createApp({
    config: { webOrigin: WEB_ORIGIN, api: { port: 0, trustProxy: "loopback" } },
    logger: pino({ level: "silent" }),
    redis,
    readinessChecks: {
      postgres: async () => {},
      redis: async () => {
        if (options.ready === false) throw new Error("connection refused");
      },
    },
    routers: [{ path: "/api/demo", router: demo }],
    ipRateLimit: { windowMs: 60_000, limit: options.limit ?? 1_000 },
  });
}

beforeAll(async () => {
  redis = createRedis(TEST_REDIS_URL);
  await redis.ping();
});

afterAll(async () => {
  await redis.quit();
});

describe("health and readiness", () => {
  it("GET /api/health is always ok", async () => {
    const res = await request(buildApp({ ready: false })).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /api/ready is 200 when every check passes", async () => {
    const res = await request(buildApp()).get("/api/ready");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.checks.postgres.ok).toBe(true);
  });

  it("GET /api/ready is 503 and names the failing check", async () => {
    const res = await request(buildApp({ ready: false })).get("/api/ready");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("not_ready");
    expect(res.body.checks.redis).toMatchObject({ ok: false, error: "connection refused" });
    expect(res.body.checks.postgres.ok).toBe(true);
  });
});

describe("request context and security", () => {
  it("returns a UUIDv7 request ID, or echoes a safe incoming one", async () => {
    const app = buildApp();
    const generated = await request(app).get("/api/health");
    expect(isUuidV7(generated.headers["x-request-id"] ?? "")).toBe(true);

    const echoed = await request(app).get("/api/health").set("X-Request-Id", "abc-123");
    expect(echoed.headers["x-request-id"]).toBe("abc-123");

    const unsafe = await request(app).get("/api/health").set("X-Request-Id", "bad id <script>");
    expect(isUuidV7(unsafe.headers["x-request-id"] ?? "")).toBe(true);
  });

  it("sets helmet headers and hides x-powered-by", async () => {
    const res = await request(buildApp()).get("/api/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("allows CORS only from the app origin, with credentials", async () => {
    const app = buildApp();
    const ok = await request(app).get("/api/health").set("Origin", WEB_ORIGIN);
    expect(ok.headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
    expect(ok.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("allows any origin on /api/public/*", async () => {
    const res = await request(buildApp())
      .options("/api/public/status/x")
      .set("Origin", "https://customer.example")
      .set("Access-Control-Request-Method", "GET");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});

describe("errors as problem JSON", () => {
  it("unknown routes return 404 not_found", async () => {
    const res = await request(buildApp()).get("/api/nope");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    const problem = problemSchema.parse(JSON.parse(res.text));
    expect(problem.code).toBe("not_found");
    expect(problem.requestId).toBe(res.headers["x-request-id"]);
  });

  it("AppError subclasses map to their status and code", async () => {
    const res = await request(buildApp()).get("/api/demo/conflict");
    expect(res.status).toBe(409);
    expect(JSON.parse(res.text)).toMatchObject({ code: "conflict", detail: "Already exists." });
  });

  it("unexpected errors become 500 without leaking details", async () => {
    const res = await request(buildApp()).get("/api/demo/boom");
    expect(res.status).toBe(500);
    expect(res.text).not.toContain("secret internal detail");
    expect(JSON.parse(res.text).code).toBe("internal_error");
  });

  it("malformed JSON returns 400 validation_failed", async () => {
    const res = await request(buildApp())
      .post("/api/demo/echo")
      .set("Content-Type", "application/json")
      .send("{bad");
    expect(res.status).toBe(400);
    expect(JSON.parse(res.text).code).toBe("validation_failed");
  });

  it("bodies over 1 MB return 413 payload_too_large", async () => {
    const res = await request(buildApp())
      .post("/api/demo/echo")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ data: "x".repeat(1_100_000) }));
    expect(res.status).toBe(413);
    expect(JSON.parse(res.text).code).toBe("payload_too_large");
  });
});

describe("rate limiting (Redis store)", () => {
  it("returns 429 rate_limited after the per-IP limit", async () => {
    const app = buildApp({ limit: 2 });
    const ip = randomIp();
    const call = () => request(app).get("/api/demo/conflict").set("X-Forwarded-For", ip);
    expect((await call()).status).toBe(409);
    expect((await call()).status).toBe(409);
    const limited = await call();
    expect(limited.status).toBe(429);
    expect(JSON.parse(limited.text).code).toBe("rate_limited");
  });

  it("never rate-limits health checks", async () => {
    const app = buildApp({ limit: 1 });
    const ip = randomIp();
    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).get("/api/health").set("X-Forwarded-For", ip);
      expect(res.status).toBe(200);
    }
  });
});
