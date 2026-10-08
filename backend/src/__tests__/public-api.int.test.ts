/*
 * P6-T01 through the real app: API keys are made by admins and shown once; `/api/v1` answers only
 * to a valid key, within the key's scopes, its workspace, the plan and the rate limit; writes are
 * idempotent with an Idempotency-Key; and the OpenAPI document describes exactly the routes that
 * exist.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import type { ApiScope, CreatedApiKey } from "@app/shared";
import { createFakeClock } from "../core/clock.js";
import { publicRoutesOf } from "../composition/public-api.js";
import { WEB_ORIGIN, buildContainerApp, signUpVerified } from "./helpers/container-app.js";

const DAY = 86_400_000;
const clock = createFakeClock(new Date());
const ctx = buildContainerApp({ authRateLimit: false, clock });
const run = randomBytes(4).toString("hex");
let owner: TestAgent;
let ws = "";
let other: TestAgent;
let otherWs = "";

const session = (agent: TestAgent, method: "get" | "post" | "delete", wsId: string, path: string) =>
  agent[method](`/api/w/${wsId}${path}`).set("Origin", WEB_ORIGIN);
const v1 = (key: string | undefined, method: "get" | "post" | "patch" | "delete", path: string) => {
  const req = request(ctx.app)[method](`/api/v1${path}`);
  return key === undefined ? req : req.set("Authorization", `Bearer ${key}`);
};

async function makeKey(
  scopes: ApiScope[],
  options: { agent?: TestAgent; wsId?: string; expiresInDays?: number } = {},
): Promise<CreatedApiKey> {
  const res = await session(options.agent ?? owner, "post", options.wsId ?? ws, "/api-keys").send({
    name: `key ${scopes.join(" ")}`,
    scopes,
    ...(options.expiresInDays === undefined ? {} : { expiresInDays: options.expiresInDays }),
  });
  expect(res.status, res.text).toBe(201);
  return res.body as CreatedApiKey;
}

const monitorBody = (name: string) => ({
  settings: { name },
  config: { type: "tcp", host: "example.com", port: 443 },
});

async function workspace(agent: TestAgent, label: string): Promise<string> {
  await signUpVerified(ctx, agent, `${label}-${run}@example.com`);
  const created = await agent
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: `${label} Co`, slug: `${label}-${run}` });
  expect(created.status, created.text).toBe(200);
  return created.body.id as string;
}

beforeAll(async () => {
  owner = request.agent(ctx.app);
  other = request.agent(ctx.app);
  ws = await workspace(owner, "api");
  otherWs = await workspace(other, "api-other");
}, 120_000);

afterAll(async () => {
  await ctx.container.close();
});

describe("API keys", () => {
  it("a key is shown once, listed by its prefix, and stops working when revoked", async () => {
    const created = await makeKey(["monitors:read", "monitors:read"]);
    expect(created.key).toMatch(/^wp_[A-Za-z0-9]{12}_[A-Za-z0-9]{40}$/);
    expect(created.prefix).toBe(created.key.slice(0, 15));
    expect(created.scopes).toEqual(["monitors:read"]);
    expect(created.expiresAt).toBeNull();

    const list = await session(owner, "get", ws, "/api-keys");
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(created.key.slice(16));
    expect(list.body.data[0]).toMatchObject({ id: created.id, prefix: created.prefix });
    /* The database holds a hash, never the key. */
    const stored = await ctx.container.infra.db.execute<{ hash: string }>(
      sql`select hash from api_keys where id = ${created.id}`,
    );
    expect(stored.rows[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0]?.hash).not.toContain(created.key.slice(16));

    expect((await v1(created.key, "get", "/me")).status).toBe(200);
    const used = await session(owner, "get", ws, "/api-keys");
    expect(used.body.data[0].lastUsedAt).not.toBeNull();

    const revoked = await session(owner, "delete", ws, `/api-keys/${created.id}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.revokedAt).not.toBeNull();
    expect((await v1(created.key, "get", "/me")).status).toBe(401);
    expect((await session(owner, "delete", ws, `/api-keys/${created.id}`)).status).toBe(404);
  });

  it("refuses requests without a working key", async () => {
    const missing = await v1(undefined, "get", "/monitors");
    expect(missing.status).toBe(401);
    expect(missing.headers["www-authenticate"]).toBe("Bearer");
    expect(missing.body).toMatchObject({ status: 401, code: "unauthorized" });
    expect((await v1("not-a-key", "get", "/monitors")).status).toBe(401);
    const real = await makeKey(["monitors:read"]);
    /* The right prefix with a wrong secret is still wrong. */
    const forged = `${real.key.slice(0, 16)}${"A".repeat(40)}`;
    expect((await v1(forged, "get", "/monitors")).status).toBe(401);
    /* A session cookie is not a key. */
    expect((await owner.get("/api/v1/monitors").set("Origin", WEB_ORIGIN)).status).toBe(401);
  });

  it("a key with an expiry stops on that day", async () => {
    const key = await makeKey(["monitors:read"], { expiresInDays: 2 });
    expect(new Date(key.expiresAt ?? 0).getTime()).toBe(clock.now().getTime() + 2 * DAY);
    expect((await v1(key.key, "get", "/me")).body).toMatchObject({
      workspaceId: ws,
      workspaceName: "api Co",
      scopes: ["monitors:read"],
      expiresAt: key.expiresAt,
    });
    clock.advance(2 * DAY + 1_000);
    expect((await v1(key.key, "get", "/me")).status).toBe(401);
    clock.advance(-(2 * DAY + 1_000));
  });

  it("validates what a key is asked to be", async () => {
    const bad = async (body: Record<string, unknown>) =>
      (await session(owner, "post", ws, "/api-keys").send(body)).status;
    expect(await bad({ name: "x", scopes: [] })).toBe(400);
    expect(await bad({ name: "x", scopes: ["everything"] })).toBe(400);
    expect(await bad({ name: "", scopes: ["monitors:read"] })).toBe(400);
    expect(await bad({ name: "x", scopes: ["monitors:read"], expiresInDays: 0 })).toBe(400);
  });
});

describe("/api/v1", () => {
  let reader: string;
  let writer: string;
  let monitorId = "";

  beforeAll(async () => {
    reader = (await makeKey(["monitors:read", "incidents:read"])).key;
    writer = (
      await makeKey(["monitors:write", "incidents:write", "maintenance:write", "status_pages:read"])
    ).key;
  });

  it("creates, reads, changes, pauses and deletes monitors", async () => {
    const created = await v1(writer, "post", "/monitors").send(monitorBody("API monitor"));
    expect(created.status, created.text).toBe(201);
    monitorId = created.body.id as string;
    /* The answer is v1's own shape: these fields and no others. */
    expect(Object.keys(created.body).sort()).toEqual(
      [
        "config",
        "createdAt",
        "groupId",
        "id",
        "intervalSeconds",
        "name",
        "paused",
        "regions",
        "severity",
        "tags",
        "timeoutMs",
        "type",
        "updatedAt",
      ].sort(),
    );
    expect(created.body).toMatchObject({ name: "API monitor", type: "tcp", paused: false });

    await v1(writer, "post", "/monitors").send(monitorBody("Second monitor"));
    const first = await v1(reader, "get", "/monitors?limit=1");
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(1);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await v1(reader, "get", `/monitors?limit=1&cursor=${first.body.nextCursor}`);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
    expect(second.body.nextCursor).toBeNull();

    const changed = await v1(writer, "patch", `/monitors/${monitorId}`).send({
      settings: { name: "Renamed by API" },
    });
    expect(changed.status, changed.text).toBe(200);
    expect(changed.body.name).toBe("Renamed by API");
    expect((await v1(writer, "post", `/monitors/${monitorId}/pause`)).body.paused).toBe(true);
    expect((await v1(writer, "post", `/monitors/${monitorId}/resume`)).body.paused).toBe(false);
    expect((await v1(reader, "get", `/monitors/${monitorId}`)).body.name).toBe("Renamed by API");

    const invalid = await v1(writer, "post", "/monitors").send({ settings: { name: "x" } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe("validation_failed");
  });

  it("keeps a key inside its scopes; a write scope includes reading", async () => {
    const refused = await v1(reader, "post", "/monitors").send(monitorBody("No"));
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toContain("monitors:write");
    expect((await v1(reader, "get", "/maintenance-windows")).status).toBe(403);
    expect((await v1(reader, "get", "/status-pages")).status).toBe(403);
    expect((await v1(writer, "get", "/monitors")).status).toBe(200);
    expect((await v1(writer, "get", "/maintenance-windows")).status).toBe(200);
    /* Read-only scopes can't be used to write. */
    expect((await v1(writer, "get", "/status-pages")).status).toBe(200);
  });

  it("a key opens its own workspace only", async () => {
    const theirs = await makeKey(["monitors:write"], { agent: other, wsId: otherWs });
    expect((await v1(theirs.key, "get", `/monitors/${monitorId}`)).status).toBe(404);
    expect((await v1(theirs.key, "delete", `/monitors/${monitorId}`)).status).toBe(404);
    expect((await v1(theirs.key, "get", "/monitors")).body.data).toEqual([]);
    expect((await v1(reader, "get", `/monitors/${monitorId}`)).status).toBe(200);
  });

  it("lists, acknowledges and resolves incidents", async () => {
    const opened = await session(owner, "post", ws, "/incidents").send({
      title: "Queue is stuck",
      severity: "high",
    });
    expect(opened.status, opened.text).toBe(201);
    const number = opened.body.number as number;

    const list = await v1(reader, "get", "/incidents?status=open");
    expect(list.status).toBe(200);
    expect(list.body.data.map((i: { number: number }) => i.number)).toContain(number);
    expect((await v1(reader, "post", `/incidents/${number}/acknowledge`)).status).toBe(403);

    const acked = await v1(writer, "post", `/incidents/${number}/acknowledge`);
    expect(acked.status, acked.text).toBe(200);
    expect(acked.body).toMatchObject({ number, status: "acknowledged" });
    expect(acked.body.acknowledgedAt).not.toBeNull();
    /* The timeline says it came through the API. */
    const detail = await session(owner, "get", ws, `/incidents/${number}`);
    const ack = (detail.body.timeline as Array<{ type: string; data: { via?: string } }>).find(
      (e) => e.type === "acknowledged",
    );
    expect(ack?.data.via).toBe("api");

    const resolved = await v1(writer, "post", `/incidents/${opened.body.id}/resolve`);
    expect(resolved.body).toMatchObject({ number, status: "resolved" });
    expect((await v1(reader, "get", `/incidents/${number}`)).body.status).toBe("resolved");
    expect((await v1(reader, "get", "/incidents/999999")).status).toBe(404);
  });

  it("creates and deletes maintenance windows and lists status pages", async () => {
    const start = clock.now().getTime() + 3_600_000;
    const created = await v1(writer, "post", "/maintenance-windows").send({
      name: "Deploy",
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(start + 3_600_000).toISOString(),
      scope: { monitorIds: [monitorId] },
    });
    expect(created.status, created.text).toBe(201);
    expect(created.body).toMatchObject({ name: "Deploy", active: false, suppressAlerts: true });
    const list = await v1(writer, "get", "/maintenance-windows");
    expect(list.body.data.map((w: { id: string }) => w.id)).toContain(created.body.id);
    const removed = await v1(writer, "delete", `/maintenance-windows/${created.body.id}`);
    expect(removed.status).toBe(204);
    expect(removed.text).toBe("");

    await session(owner, "post", ws, "/status-pages").send({
      name: "API status",
      slug: `api-${run}`,
      monitorIds: [monitorId],
    });
    const pages = await v1(writer, "get", "/status-pages");
    expect(pages.body.data).toHaveLength(1);
    expect(pages.body.data[0]).toMatchObject({ name: "API status", published: true });
    expect(pages.body.data[0].components[0].monitorId).toBe(monitorId);
  });

  it("does a write once when it is sent twice with the same Idempotency-Key", async () => {
    const send = (name: string, key = `create-${run}`) =>
      v1(writer, "post", "/monitors").set("Idempotency-Key", key).send(monitorBody(name));
    const first = await send("Made once");
    expect(first.status, first.text).toBe(201);
    expect(first.headers["idempotency-replayed"]).toBeUndefined();
    const again = await send("Made once");
    expect(again.status).toBe(201);
    expect(again.headers["idempotency-replayed"]).toBe("true");
    expect(again.body).toEqual(first.body);
    const all = await v1(reader, "get", "/monitors?q=Made%20once");
    expect(all.body.data).toHaveLength(1);

    /* The same key for something else is a mistake in the caller, not a new request. */
    const different = await send("Something else");
    expect(different.status).toBe(409);
    expect(different.body.code).toBe("conflict");

    /* A refused request frees its key: fix the request and send it again. */
    const refused = await v1(writer, "post", "/monitors")
      .set("Idempotency-Key", `retry-${run}`)
      .send({ settings: { name: "Broken" } });
    expect(refused.status).toBe(400);
    expect((await send("Fixed", `retry-${run}`)).status).toBe(201);

    /* Deletes replay too, with their empty answer. */
    const target = (await send("To delete", `make-${run}`)).body.id as string;
    const remove = () =>
      v1(writer, "delete", `/monitors/${target}`).set("Idempotency-Key", `delete-${run}`);
    expect((await remove()).status).toBe(204);
    const replay = await remove();
    expect(replay.status).toBe(204);
    expect(replay.headers["idempotency-replayed"]).toBe("true");

    expect(
      (await v1(writer, "post", "/monitors").set("Idempotency-Key", "x".repeat(201)).send({}))
        .status,
    ).toBe(400);
    /* Old keys are forgotten after 24 hours. */
    clock.advance(25 * 3_600_000);
    const apikeys = ctx.container.modules.find((m) => m.name === "apikeys") as unknown as {
      service: { purgeIdempotencyKeys(): Promise<number> };
    };
    expect(await apikeys.service.purgeIdempotencyKeys()).toBeGreaterThanOrEqual(4);
    clock.advance(-25 * 3_600_000);
  });

  it("deletes a monitor", async () => {
    expect((await v1(writer, "delete", `/monitors/${monitorId}`)).status).toBe(204);
    expect((await v1(reader, "get", `/monitors/${monitorId}`)).status).toBe(404);
  });

  it("the Free plan reads through the API and can't write", async () => {
    /* The Pro trial ends and nothing was bought: the workspace is on Free. */
    clock.advance(20 * DAY);
    try {
      expect((await session(owner, "get", ws, "/entitlements")).body.plan).toBe("free");
      expect((await v1(writer, "get", "/monitors")).status).toBe(200);
      const refused = await v1(writer, "post", "/monitors").send(monitorBody("On Free"));
      expect(refused.status).toBe(402);
      expect(refused.body.code).toBe("quota_exceeded");
      const key = await session(owner, "post", ws, "/api-keys").send({
        name: "write on free",
        scopes: ["monitors:write"],
      });
      expect(key.status).toBe(402);
      expect(
        (
          await session(owner, "post", ws, "/api-keys").send({
            name: "r",
            scopes: ["monitors:read"],
          })
        ).status,
      ).toBe(201);
    } finally {
      clock.advance(-20 * DAY);
    }
  });
});

describe("rate limit per key", () => {
  it("answers 429 past the limit, for that key only", async () => {
    const limited = buildContainerApp({
      authRateLimit: false,
      env: { API_KEY_RATE_LIMIT_PER_MINUTE: "3" },
    });
    try {
      const a = (await makeKey(["monitors:read"])).key;
      const b = (await makeKey(["monitors:read"])).key;
      const call = (key: string) =>
        request(limited.app).get("/api/v1/me").set("Authorization", `Bearer ${key}`);
      for (let i = 0; i < 3; i += 1) expect((await call(a)).status).toBe(200);
      const over = await call(a);
      expect(over.status).toBe(429);
      expect(over.body.code).toBe("rate_limited");
      expect(over.headers["ratelimit"]).toBeDefined();
      expect((await call(b)).status).toBe(200);
    } finally {
      await limited.container.close();
    }
  });
});

describe("OpenAPI", () => {
  it("describes every route, and needs no key to read", async () => {
    const res = await request(ctx.app).get("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    const doc = res.body as {
      openapi: string;
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> };
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.components.securitySchemes.apiKey).toEqual({ type: "http", scheme: "bearer" });
    expect(doc.components.schemas.Problem).toBeDefined();

    const routes = publicRoutesOf(ctx.container.modules);
    const documented = Object.entries(doc.paths).flatMap(([path, methods]) =>
      Object.keys(methods).map((method) => `${method} ${path}`),
    );
    expect(documented.sort()).toEqual(
      routes.map((r) => `${r.method} ${r.path.replace(/:(\w+)/g, "{$1}")}`).sort(),
    );
    expect(documented).toEqual(
      expect.arrayContaining([
        "get /me",
        "get /monitors",
        "post /monitors",
        "patch /monitors/{monitorId}",
        "delete /monitors/{monitorId}",
        "post /incidents/{incidentRef}/acknowledge",
        "post /maintenance-windows",
        "get /status-pages",
      ]),
    );

    const create = doc.paths["/monitors"]?.post as {
      operationId: string;
      description: string;
      parameters: Array<{ name: string; in: string }>;
      requestBody: { content: { "application/json": { schema: { properties: object } } } };
      responses: Record<string, unknown>;
    };
    expect(create.description).toContain("`monitors:write`");
    expect(create.parameters).toContainEqual(
      expect.objectContaining({ name: "Idempotency-Key", in: "header" }),
    );
    expect(Object.keys(create.requestBody.content["application/json"].schema.properties)).toEqual(
      expect.arrayContaining(["settings", "config"]),
    );
    expect(Object.keys(create.responses)).toEqual(
      expect.arrayContaining(["201", "400", "401", "402", "403", "429"]),
    );
    const one = doc.paths["/monitors/{monitorId}"]?.get as {
      parameters: Array<{ name: string; in: string; required: boolean }>;
    };
    expect(one.parameters).toContainEqual(
      expect.objectContaining({ name: "monitorId", in: "path", required: true }),
    );
    /* docs/api.md lists every route too. */
    const guide = readFileSync(new URL("../../../docs/api.md", import.meta.url), "utf8");
    for (const route of routes) {
      expect(guide).toContain(`| \`${route.method.toUpperCase()} ${route.path}\``);
    }
    /* Every operation has its own ID, so client generators don't collide. */
    const ids = Object.values(doc.paths).flatMap((methods) =>
      Object.values(methods).map((op) => op.operationId as string),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});
