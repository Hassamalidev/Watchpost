/*
 * P1-T08 AC through the real composition: bad signatures are rejected, assignments follow monitor
 * changes, duplicate result batches don't duplicate rows, and a task reaches a long-polling probe in
 * under 1 s (NOTIFY), then completes with its result.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { v7 as uuidv7 } from "uuid";
import type { ProbesModule } from "../index.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  countResults,
  probeClient,
  signUpVerified,
} from "../../../__tests__/helpers/container-app.js";

let ctx: ReturnType<typeof buildContainerApp>;
let owner: TestAgent;
let ws: string;
let probe: { id: string; secret: string };
let client: ReturnType<typeof probeClient>;
const monitorIds: Record<string, string> = {};

const post = (path: string, body: object) => owner.post(path).set("Origin", WEB_ORIGIN).send(body);
const patch = (path: string, body: object) =>
  owner.patch(path).set("Origin", WEB_ORIGIN).send(body);

async function createMonitor(name: string, settings: object, config: object) {
  const res = await post(`/api/w/${ws}/monitors`, { settings: { name, ...settings }, config });
  expect(res.status, res.text).toBe(201);
  return res.body.id as string;
}

function result(monitorId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: uuidv7(),
    monitorId,
    region: "eu-central",
    checkedAt: new Date().toISOString(),
    ok: true,
    latencyMs: 12,
    ...overrides,
  };
}

beforeAll(async () => {
  ctx = buildContainerApp();
  owner = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `probe-owner-${randomBytes(4).toString("hex")}@example.com`);
  const created = await post("/api/auth/organization/create", {
    name: "Probe Co",
    slug: `probe-co-${randomBytes(4).toString("hex")}`,
  });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id;

  const probes = ctx.container.modules.find((m) => m.name === "probes") as ProbesModule;
  probe = await probes.service.register({
    name: `test-${randomBytes(3).toString("hex")}`,
    region: "eu-central",
    kind: "managed",
  });
  client = probeClient(ctx.app, probe);

  monitorIds.tcp = await createMonitor("TCP", {}, { type: "tcp", host: "example.com", port: 443 });
  monitorIds.usOnly = await createMonitor(
    "US only",
    { regions: ["us-east"] },
    { type: "tcp", host: "example.org", port: 443 },
  );
  monitorIds.heartbeat = await createMonitor(
    "Cron",
    {},
    { type: "heartbeat", schedule: { kind: "period", periodSeconds: 600 } },
  );
  monitorIds.paused = await createMonitor(
    "Paused",
    {},
    { type: "tcp", host: "example.net", port: 443 },
  );
  await post(`/api/w/${ws}/monitors/${monitorIds.paused}/pause`, {});
});

afterAll(async () => {
  await ctx.container.close();
});

describe("authentication", () => {
  it("accepts a correctly signed hello", async () => {
    const res = await client.call("POST", "/hello", {
      version: "0.1.0",
      mode: "managed",
      region: "eu-central",
      capabilities: ["http", "tcp"],
    });
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ probeId: probe.id, syncIntervalMs: 15_000 });
  });

  it("rejects a wrong region, bad secrets, unknown probes, stale clocks and tampered bodies", async () => {
    const hello = { version: "0.1.0", mode: "managed", region: "us-east", capabilities: [] };
    expect((await client.call("POST", "/hello", hello)).status).toBe(400);

    const wrongSecret = probeClient(ctx.app, { id: probe.id, secret: "x".repeat(43) });
    expect((await wrongSecret.call("GET", "/assignments")).status).toBe(401);

    const unknown = probeClient(ctx.app, { id: uuidv7(), secret: probe.secret });
    expect((await unknown.call("GET", "/assignments")).status).toBe(401);

    const stale = probeClient(ctx.app, probe, { now: () => Date.now() - 5 * 60_000 });
    expect((await stale.call("GET", "/assignments")).status).toBe(401);

    const body = JSON.stringify({ batchId: uuidv7(), results: [result(monitorIds.tcp ?? "")] });
    const headers = client.sign("POST", "/api/probe/v1/results", body);
    const tampered = request(ctx.app)
      .post("/api/probe/v1/results")
      .set("content-type", "application/json");
    for (const [k, v] of Object.entries(headers)) tampered.set(k, v);
    expect((await tampered.send(body.replace('"ok":true', '"ok":false'))).status).toBe(401);

    expect((await request(ctx.app).get("/api/probe/v1/assignments")).status).toBe(401);
  });
});

describe("assignments", () => {
  let cursor = 0;

  it("full sync includes only active, probe-run monitors in the probe's region", async () => {
    const res = await client.call("GET", "/assignments?full=true");
    expect(res.status, res.text).toBe(200);
    const ids = res.body.upserts.map((m: { id: string }) => m.id);
    expect(res.body.full).toBe(true);
    expect(ids).toContain(monitorIds.tcp);
    expect(ids).not.toContain(monitorIds.usOnly);
    expect(ids).not.toContain(monitorIds.heartbeat);
    expect(ids).not.toContain(monitorIds.paused);
    cursor = res.body.cursor;
  });

  it("delta sync reports new monitors and turns region changes and deletes into deletes", async () => {
    const added = await createMonitor("Added", {}, { type: "tcp", host: "example.com", port: 80 });
    await patch(`/api/w/${ws}/monitors/${monitorIds.tcp}`, { settings: { regions: ["us-east"] } });
    await owner.delete(`/api/w/${ws}/monitors/${monitorIds.paused}`).set("Origin", WEB_ORIGIN);

    const res = await client.call("GET", `/assignments?after=${cursor}`);
    expect(res.body.full).toBe(false);
    expect(res.body.upserts.map((m: { id: string }) => m.id)).toContain(added);
    expect(res.body.deletes).toEqual(expect.arrayContaining([monitorIds.tcp, monitorIds.paused]));
    expect(res.body.cursor).toBeGreaterThan(cursor);
    monitorIds.added = added;
  });
});

describe("results", () => {
  it("stores a batch once however often it is sent, and refuses unassigned monitors", async () => {
    const batch = {
      batchId: uuidv7(),
      results: [
        result(monitorIds.added ?? ""),
        result(monitorIds.added ?? "", { ok: false, errorCode: "connect_refused" }),
      ],
    };
    const first = await client.call("POST", "/results", batch);
    expect(first.status, first.text).toBe(202);
    expect(first.body).toEqual({ accepted: 2, duplicates: 0 });
    const again = await client.call("POST", "/results", batch);
    expect(again.body).toEqual({ accepted: 0, duplicates: 2 });
    expect(
      await countResults(
        ctx.container,
        batch.results.map((r) => r.id),
      ),
    ).toBe(2);

    const foreign = result(monitorIds.usOnly ?? "");
    const wrongRegion = result(monitorIds.added ?? "", { region: "us-east" });
    const refused = await client.call("POST", "/results", {
      batchId: uuidv7(),
      results: [foreign, wrongRegion],
    });
    expect(refused.body).toEqual({ accepted: 0, duplicates: 2 });
    expect(await countResults(ctx.container, [foreign.id, wrongRegion.id])).toBe(0);
  });

  it("rejects malformed batches", async () => {
    expect((await client.call("POST", "/results", { batchId: "nope", results: [] })).status).toBe(
      400,
    );
  });
});

describe("tasks", () => {
  it("delivers a Test now task to a waiting probe in under 1 s and completes it with the result", async () => {
    const polling = (async () => {
      const started = Date.now();
      const res = await client.call("GET", "/tasks?wait=10");
      return { res, receivedAt: Date.now(), started };
    })();
    await new Promise((r) => setTimeout(r, 300));

    const createdAt = Date.now();
    const test = await post(`/api/w/${ws}/monitors/${monitorIds.added}/test`, {});
    expect(test.status, test.text).toBe(202);
    const task = test.body.data.find((t: { region: string }) => t.region === "eu-central");
    expect(task).toBeDefined();

    const { res, receivedAt } = await polling;
    expect(res.status).toBe(200);
    expect(res.body.tasks.map((t: { id: string }) => t.id)).toContain(task.id);
    expect(receivedAt - createdAt).toBeLessThan(1_000);
    expect(res.body.tasks[0].monitor.id).toBe(monitorIds.added);

    const taskResult = result(monitorIds.added ?? "", { taskId: task.id, latencyMs: 33 });
    await client.call("POST", "/results", { batchId: uuidv7(), results: [taskResult] });
    const status = await owner.get(`/api/w/${ws}/probe-tasks/${task.id}`).set("Origin", WEB_ORIGIN);
    expect(status.body).toMatchObject({
      status: "completed",
      result: { id: taskResult.id, latencyMs: 33 },
    });
  });

  it("refuses to test a paused monitor (probes would never run it)", async () => {
    const path = `/api/w/${ws}/monitors/${monitorIds.added}`;
    expect((await post(`${path}/pause`, {})).status).toBe(200);
    const test = await post(`${path}/test`, {});
    expect(test.status).toBe(400);
    expect(test.text).toContain("paused");
    expect((await post(`${path}/resume`, {})).status).toBe(200);
  });

  it("returns an empty list when nothing arrives before the wait ends", async () => {
    const started = Date.now();
    const res = await client.call("GET", "/tasks?wait=1");
    expect(res.body.tasks).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });
});

describe("heartbeat", () => {
  it("records the probe's stats", async () => {
    const res = await client.call("POST", "/heartbeat", {
      version: "0.1.0",
      uptimeSeconds: 10,
      assigned: 1,
      inFlight: 0,
      queueDepth: 0,
      bufferedResults: 0,
    });
    expect(res.status).toBe(204);
  });
});
