/*
 * The real composition (createContainer + createApp) against the test database and Redis, for tests
 * that need the whole API, including the probe protocol. Emails are read back from the outbox.
 */
import { createHash, createHmac } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { pino } from "pino";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { expect } from "vitest";
import { PROBE_API_PREFIX, PROBE_HEADERS, probeSigningString } from "@app/shared";
import { createApp } from "../../app.js";
import { createContainer } from "../../composition/container.js";
import { parseEnv, toAppConfig } from "../../config/index.js";
import type { Clock } from "../../core/clock.js";
import type { DnsLookup } from "../../infra/dns.js";
import type { PaddleApi } from "../../infra/paddle/index.js";
import type { OutboundHttp, OutboundRequest, OutboundResponse } from "../../infra/http/outbound.js";
import { outboxEvents } from "../../infra/outbox/index.js";
import { createMemoryObjectStore } from "../../infra/storage/index.js";
import { TEST_DATABASE_URL, TEST_REDIS_URL } from "./test-env.js";

export const WEB_ORIGIN = "http://localhost:3000";
export const PASSWORD = "correct horse battery";

export function buildContainerApp(
  options: {
    authRateLimit?: boolean;
    /* Extra environment (for example Slack or Telegram credentials). */
    env?: Record<string, string>;
    http?: OutboundHttp;
    /* A controllable clock for everything that reads `infra.clock` (trial ends, grace periods). */
    clock?: Clock;
    /* A fake Paddle API; needs the PADDLE_* variables in `env` to switch billing on. */
    paddleApi?: PaddleApi;
    /* Records the cache tags the web app would be told to drop. */
    revalidate?: (tags: string[]) => Promise<void>;
    /* Answers DNS lookups (custom status page domains). */
    dns?: DnsLookup;
  } = {},
) {
  const config = toAppConfig(
    parseEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      WEB_ORIGIN,
      DATABASE_URL: TEST_DATABASE_URL,
      REDIS_URL: TEST_REDIS_URL,
      /* Same key as the workspace test app, so monitors created by other test files decrypt here. */
      TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString("base64"),
      TOKEN_ENC_KEY_ID: "test",
      BETTER_AUTH_SECRET: "container-test-secret-".padEnd(40, "z"),
      BETTER_AUTH_URL: "http://localhost:4000",
      ...options.env,
    }),
  );
  /* TEST_LOG_LEVEL=error shows server errors while debugging a test. */
  const logger = pino({ level: process.env.TEST_LOG_LEVEL ?? "silent" });
  /* Object storage in memory, so tests can read what was stored. */
  const objects = createMemoryObjectStore();
  const container = createContainer(config, {
    service: "api",
    logger,
    objects,
    ...(options.authRateLimit === false ? { authRateLimit: false } : {}),
    ...(options.http === undefined ? {} : { http: options.http }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.paddleApi === undefined ? {} : { paddleApi: options.paddleApi }),
    ...(options.revalidate === undefined ? {} : { revalidate: options.revalidate }),
    ...(options.dns === undefined ? {} : { dns: options.dns }),
  });
  const app = createApp({
    config,
    logger,
    redis: container.infra.redis,
    readinessChecks: container.readinessChecks,
    routers: container.routers,
    rawBodyRouters: container.rawBodyRouters,
    ipRateLimit: { windowMs: 60_000, limit: 100_000 },
  });
  return { app, container, config, objects };
}

/* The latest email.requested payload for a recipient (emails go through the outbox). */
export async function emailFromOutbox(
  container: ReturnType<typeof buildContainerApp>["container"],
  to: string,
  template: string,
): Promise<Record<string, unknown>> {
  const rows = await container.infra.db
    .select({ payload: outboxEvents.payload })
    .from(outboxEvents)
    .where(eq(outboxEvents.type, "email.requested"))
    .orderBy(desc(outboxEvents.createdAt))
    .limit(200);
  const hit = rows
    .map((r) => r.payload as { to: string; template: string; data: Record<string, unknown> })
    .find((p) => p.to === to && p.template === template);
  if (hit === undefined) throw new Error(`no ${template} email to ${to} in the outbox`);
  return hit.data;
}

export async function signUpVerified(
  ctx: ReturnType<typeof buildContainerApp>,
  agent: TestAgent,
  email: string,
): Promise<void> {
  const signUp = await agent
    .post("/api/auth/sign-up/email")
    .set("Origin", WEB_ORIGIN)
    .send({ email, password: PASSWORD, name: email.split("@")[0] });
  expect(signUp.status, signUp.text).toBe(200);
  const { url } = await emailFromOutbox(ctx.container, email, "verify-email");
  const link = new URL(String(url));
  await agent.get(`${link.pathname}${link.search}`).set("Origin", WEB_ORIGIN);
}

/* A test client that signs requests exactly like the probe does (§7.6). */
export function probeClient(
  app: ReturnType<typeof buildContainerApp>["app"],
  creds: { id: string; secret: string },
  options: { now?: () => number } = {},
) {
  const sign = (method: string, path: string, body: string) => {
    const timestamp = String(Math.floor((options.now ?? Date.now)() / 1_000));
    const signature = createHmac("sha256", creds.secret)
      .update(
        probeSigningString({
          timestamp,
          method,
          path,
          bodySha256Hex: createHash("sha256").update(body).digest("hex"),
        }),
      )
      .digest("hex");
    return {
      [PROBE_HEADERS.id]: creds.id,
      [PROBE_HEADERS.timestamp]: timestamp,
      [PROBE_HEADERS.signature]: signature,
    };
  };
  const call = (method: "GET" | "POST", path: string, body?: unknown) => {
    const full = `${PROBE_API_PREFIX}${path}`;
    const payload = body === undefined ? "" : JSON.stringify(body);
    const headers = sign(method, full.split("?")[0] ?? full, payload);
    const req = method === "GET" ? request(app).get(full) : request(app).post(full);
    for (const [k, v] of Object.entries(headers)) req.set(k, v);
    if (body !== undefined) req.set("content-type", "application/json").send(payload);
    return req;
  };
  return { call, sign };
}

export async function countResults(
  container: ReturnType<typeof buildContainerApp>["container"],
  ids: string[],
): Promise<number> {
  const r = await container.infra.db.execute<{ n: number }>(
    sql`select count(*)::int as n from check_results where id in (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`,
  );
  return r.rows[0]?.n ?? 0;
}

/* Outbound HTTP stub: records every request and answers from the handler (default 200 {}). */
export function stubHttp(
  handler: (req: OutboundRequest) => Partial<OutboundResponse> | undefined = () => undefined,
) {
  const requests: OutboundRequest[] = [];
  const http: OutboundHttp & { requests: OutboundRequest[] } = {
    requests,
    async request(req) {
      requests.push(req);
      const res = handler(req) ?? {};
      return { status: res.status ?? 200, headers: res.headers ?? {}, body: res.body ?? "{}" };
    },
  };
  return http;
}
