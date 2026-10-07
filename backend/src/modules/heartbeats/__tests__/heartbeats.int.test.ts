/*
 * P1-T14 AC: missed, failed and too-long runs alert correctly, and a platform gap suppresses false
 * misses. The ping endpoint is exercised over HTTP; schedule scenarios use the service with a fake
 * clock against the real database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { createFakeClock } from "../../../core/clock.js";
import { newId } from "../../../infra/ids.js";
import type { IncidentsModule } from "../../incidents/index.js";
import type { MonitorsModule } from "../../monitors/index.js";
import { createHeartbeatsRepository } from "../heartbeats.repository.js";
import { signalOf } from "../heartbeats.routes.js";
import { createHeartbeatsService, type HeartbeatsService } from "../heartbeats.service.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  signUpVerified,
} from "../../../__tests__/helpers/container-app.js";

let ctx: ReturnType<typeof buildContainerApp>;
let owner: TestAgent;
let ws: string;
let service: HeartbeatsService;
const clock = createFakeClock();

const post = (path: string, body: object = {}) =>
  owner.post(path).set("Origin", WEB_ORIGIN).send(body);
const db = () => ctx.container.infra.db;
const rows = async <T>(query: ReturnType<typeof sql>) => (await db().execute(query)).rows as T[];

async function heartbeat(name: string, config: object = {}) {
  const res = await post(`/api/w/${ws}/monitors`, {
    settings: { name },
    config: {
      type: "heartbeat",
      schedule: { kind: "period", periodSeconds: 60 },
      graceSeconds: 30,
      ...config,
    },
  });
  expect(res.status, res.text).toBe(201);
  const monitorId = res.body.id as string;
  const token = await post(`/api/w/${ws}/heartbeats/${monitorId}/token`);
  expect(token.status, token.text).toBe(201);
  return { monitorId, token: String(token.body.url).split("/").at(-1) ?? "" };
}

const toDate = (v: Date | string | null) => (v === null ? null : new Date(v));
const state = (monitorId: string) =>
  rows<{ status: string; next_expected_at: string | null; reason: string | null }>(
    sql`select status, next_expected_at, reason from heartbeat_state where monitor_id = ${monitorId}`,
  ).then((r) =>
    r[0] === undefined ? undefined : { ...r[0], next_expected_at: toDate(r[0].next_expected_at) },
  );
const incidents = (monitorId: string) =>
  rows<{ status: string; cause_code: string; source: string }>(
    sql`select status, cause_code, source from incidents where monitor_id = ${monitorId} order by started_at`,
  );

const at = (base: number, seconds: number) => new Date(base + seconds * 1_000);

/* Moves the fake clock forward with a worker tick every 10 s, as the real worker does. */
async function advanceTo(target: Date) {
  while (clock.now().getTime() + 10_000 < target.getTime()) {
    clock.advance(10_000);
    await service.platformTick();
  }
  clock.set(target);
}

/* The Free plan allows 5 active heartbeats, so each group of tests gets its own workspace. */
async function newWorkspace() {
  const created = await post("/api/auth/organization/create", {
    name: "Cron Co",
    slug: `cron-co-${randomBytes(4).toString("hex")}`,
  });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id;
}

beforeAll(async () => {
  ctx = buildContainerApp();
  owner = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `hb-owner-${randomBytes(4).toString("hex")}@example.com`);

  /* Platform ticks and gaps are global; start this file from a clean guard. */
  await db().execute(sql`delete from platform_gaps`);
  await db().execute(sql`delete from platform_ticks`);

  const find = <T>(name: string) => ctx.container.modules.find((m) => m.name === name) as T;
  clock.set(new Date());
  service = createHeartbeatsService({
    db: db(),
    repository: createHeartbeatsRepository(),
    monitors: find<MonitorsModule>("monitors").service,
    incidents: find<IncidentsModule>("incidents").service,
    outbox: ctx.container.infra.outbox,
    clock,
    logger: ctx.container.infra.logger,
    newId,
    baseUrl: "http://localhost:4000/api/hb",
  });
});

afterAll(async () => {
  await db().execute(sql`delete from platform_gaps`);
  await db().execute(sql`delete from platform_ticks`);
  await ctx.container.close();
});

describe("ping URLs", () => {
  beforeAll(newWorkspace);
  it("parses /start, /fail and exit codes", () => {
    expect(signalOf(undefined)).toEqual({ kind: "success" });
    expect(signalOf("start")).toEqual({ kind: "start" });
    expect(signalOf("fail")).toEqual({ kind: "fail" });
    expect(signalOf("0")).toEqual({ kind: "success", exitCode: 0 });
    expect(signalOf("2")).toEqual({ kind: "fail", exitCode: 2 });
    expect(signalOf("256")).toBeUndefined();
    expect(signalOf("stop")).toBeUndefined();
  });

  it("creates a hashed token for heartbeat monitors only", async () => {
    const { monitorId, token } = await heartbeat("Nightly backup");
    const [row] = await rows<{ token_hash: string }>(
      sql`select token_hash from heartbeat_state where monitor_id = ${monitorId}`,
    );
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.token_hash).not.toContain(token);

    const http = await post(`/api/w/${ws}/monitors`, {
      settings: { name: "Site" },
      config: { type: "tcp", host: "example.com", port: 443 },
    });
    expect((await post(`/api/w/${ws}/heartbeats/${http.body.id}/token`)).status).toBe(400);
  });

  it("accepts GET and POST pings, keeps a body excerpt, and 404s unknown tokens", async () => {
    const { monitorId, token } = await heartbeat("Importer");
    expect((await request(ctx.app).get(`/api/hb/${token}`)).text).toBe("OK\n");
    const posted = await request(ctx.app)
      .post(`/api/hb/${token}/1`)
      .set("content-type", "text/plain")
      .send(`${"x".repeat(12_000)}tail`);
    expect(posted.status).toBe(200);
    expect((await request(ctx.app).get(`/api/hb/${"a".repeat(32)}`)).status).toBe(404);
    expect((await request(ctx.app).get(`/api/hb/${token}/stop`)).status).toBe(404);

    const view = await owner.get(`/api/w/${ws}/heartbeats/${monitorId}`).set("Origin", WEB_ORIGIN);
    expect(view.body).toMatchObject({ status: "down", hasToken: true });
    expect(view.body.pings.map((p: { kind: string }) => p.kind)).toEqual(["fail", "success"]);
    expect(view.body.pings[0]).toMatchObject({ exitCode: 1 });
    expect(view.body.pings[0].excerpt).toHaveLength(10 * 1024);
    expect(await incidents(monitorId)).toEqual([
      { status: "triggered", cause_code: "heartbeat_failed_signal", source: "heartbeat" },
    ]);
  });

  it("a rotated token replaces the old one", async () => {
    const { monitorId, token } = await heartbeat("Rotated");
    const rotated = await post(`/api/w/${ws}/heartbeats/${monitorId}/token`);
    const fresh = String(rotated.body.url).split("/").at(-1) ?? "";
    expect((await request(ctx.app).get(`/api/hb/${token}`)).status).toBe(404);
    expect((await request(ctx.app).get(`/api/hb/${fresh}`)).status).toBe(200);
  });

  it("rejects invalid cron schedules when the monitor is saved", async () => {
    const res = await post(`/api/w/${ws}/monitors`, {
      settings: { name: "Bad cron" },
      config: { type: "heartbeat", schedule: { kind: "cron", expression: "61 * * * *" } },
    });
    expect(res.status).toBe(400);
    const zone = await post(`/api/w/${ws}/monitors`, {
      settings: { name: "Bad zone" },
      config: {
        type: "heartbeat",
        schedule: { kind: "cron", expression: "0 3 * * *", timezone: "Mars/Olympus" },
      },
    });
    expect(zone.status).toBe(400);
  });
});

describe("schedules and alerts", () => {
  beforeAll(newWorkspace);
  it("a new heartbeat waits for its first ping; a missed deadline alerts after grace", async () => {
    const { monitorId, token } = await heartbeat("Period job");
    const t0 = Date.now();
    clock.set(at(t0, 0));
    await service.sweep();
    expect((await state(monitorId))?.status).toBe("pending");

    expect(await service.ping(token, { kind: "success" })).toBe("ok");
    expect(await state(monitorId)).toMatchObject({ status: "up", next_expected_at: at(t0, 60) });

    await advanceTo(at(t0, 85));
    await service.sweep();
    expect((await state(monitorId))?.status).toBe("up");

    await advanceTo(at(t0, 95));
    await service.sweep();
    expect((await state(monitorId))?.status).toBe("down");
    expect(await incidents(monitorId)).toEqual([
      { status: "triggered", cause_code: "heartbeat_missed", source: "heartbeat" },
    ]);

    clock.set(at(t0, 120));
    await service.ping(token, { kind: "success" });
    expect((await state(monitorId))?.status).toBe("up");
    expect((await incidents(monitorId)).map((i) => i.status)).toEqual(["resolved"]);
  });

  it("a failure signal is down at once and recovers on the next success", async () => {
    const { monitorId, token } = await heartbeat("Fail signal");
    const t0 = Date.now();
    clock.set(at(t0, 0));
    await service.ping(token, { kind: "success" });
    await service.ping(token, { kind: "fail", exitCode: 3 });
    expect(await state(monitorId)).toMatchObject({
      status: "down",
      reason: "Job reported a failure (exit code 3)",
    });
    await service.ping(token, { kind: "success", exitCode: 0 });
    expect((await state(monitorId))?.status).toBe("up");
    expect((await incidents(monitorId)).map((i) => [i.status, i.cause_code])).toEqual([
      ["resolved", "heartbeat_failed_signal"],
    ]);
  });

  it("too-long runs are degraded, whether finished or still running, without an incident", async () => {
    const { monitorId, token } = await heartbeat("Slow job", { maxDurationSeconds: 10 });
    const t0 = Date.now();
    clock.set(at(t0, 0));
    await service.ping(token, { kind: "start" });
    clock.set(at(t0, 20));
    await service.ping(token, { kind: "success" });
    expect((await state(monitorId))?.status).toBe("degraded");

    clock.set(at(t0, 30));
    await service.ping(token, { kind: "start" });
    clock.set(at(t0, 33));
    await service.ping(token, { kind: "success" });
    expect((await state(monitorId))?.status).toBe("up");

    clock.set(at(t0, 40));
    await service.ping(token, { kind: "start" });
    clock.set(at(t0, 55));
    await service.sweep();
    expect(await state(monitorId)).toMatchObject({
      status: "degraded",
      reason: "Running for more than 10 s",
    });
    expect(await incidents(monitorId)).toEqual([]);
    const pings = await rows<{ duration_ms: number | null; kind: string }>(
      sql`select duration_ms, kind from heartbeat_pings where monitor_id = ${monitorId} and kind = 'success' order by at`,
    );
    expect(pings.map((p) => p.duration_ms)).toEqual([20_000, 3_000]);
  });

  it("cron schedules expect the next occurrence in their time zone", async () => {
    const { monitorId, token } = await heartbeat("Cron job", {
      schedule: { kind: "cron", expression: "30 3 * * *", timezone: "Asia/Karachi" },
    });
    clock.set(new Date("2026-10-01T10:00:00Z"));
    await service.ping(token, { kind: "success" });
    /* 03:30 in Karachi (UTC+5) is 22:30 UTC the same day. */
    expect((await state(monitorId))?.next_expected_at).toEqual(new Date("2026-10-01T22:30:00Z"));
  });

  it("paused heartbeats never alert", async () => {
    const { monitorId, token } = await heartbeat("Paused job");
    const t0 = Date.now();
    clock.set(at(t0, 0));
    await service.ping(token, { kind: "success" });
    await post(`/api/w/${ws}/monitors/${monitorId}/pause`);
    clock.set(at(t0, 500));
    await service.sweep();
    expect((await state(monitorId))?.status).toBe("up");
    expect(await incidents(monitorId)).toEqual([]);

    /* Resuming gives the job a full period from the last sweep, not an instant missed alert. */
    clock.set(at(t0, 505));
    await post(`/api/w/${ws}/monitors/${monitorId}/resume`);
    clock.set(at(t0, 520));
    await service.sweep();
    expect(await incidents(monitorId)).toEqual([]);
    expect((await state(monitorId))?.next_expected_at).toEqual(at(t0, 560));
  });
});

describe("platform gap guard", () => {
  beforeAll(async () => {
    await newWorkspace();
    /* Earlier tests jump the fake clock, which (correctly) records worker gaps; start clean. */
    await db().execute(sql`delete from platform_gaps`);
    await db().execute(sql`delete from platform_ticks`);
  });
  it("a deadline inside a gap in our ingest doesn't alert; the next one does", async () => {
    const { monitorId, token } = await heartbeat("Guarded job");
    const t0 = Date.now();
    clock.set(at(t0, 0));
    await service.ping(token, { kind: "success" });
    await db().execute(
      sql`insert into platform_gaps (id, reason, started_at, ended_at) values (${newId()}, 'ingest', ${at(t0, 50).toISOString()}, ${at(t0, 70).toISOString()})`,
    );

    await advanceTo(at(t0, 100));
    const suppressed = await service.sweep();
    expect(suppressed.suppressed).toBeGreaterThanOrEqual(1);
    expect(await state(monitorId)).toMatchObject({ status: "up", next_expected_at: at(t0, 130) });
    expect(await incidents(monitorId)).toEqual([]);

    await advanceTo(at(t0, 161));
    await service.sweep();
    expect((await state(monitorId))?.status).toBe("down");
    expect(await incidents(monitorId)).toHaveLength(1);
  });

  it("a stale API tick opens an ingest gap that closes when the API ticks again", async () => {
    const t0 = Date.now() + 3_600_000;
    clock.set(at(t0, 0));
    await service.apiTick();
    await service.platformTick();
    clock.set(at(t0, 45));
    await service.platformTick();
    const open = await rows<{ started_at: string; ended_at: string | null }>(
      sql`select started_at, ended_at from platform_gaps where reason = 'ingest' and ended_at is null`,
    );
    expect(open.map((g) => [toDate(g.started_at), g.ended_at])).toEqual([[at(t0, 0), null]]);

    const { monitorId, token } = await heartbeat("During outage");
    clock.set(at(t0, 46));
    await service.ping(token, { kind: "success" });
    clock.set(at(t0, 140));
    await service.sweep();
    expect((await state(monitorId))?.status).toBe("up");

    await service.apiTick();
    await service.platformTick();
    const closed = await rows<{ ended_at: string | null }>(
      sql`select ended_at from platform_gaps where reason = 'ingest' order by started_at desc limit 1`,
    );
    expect(toDate(closed[0]?.ended_at ?? null)).toEqual(at(t0, 140));
  });

  it("readiness: the worker is alive while it ticks, and dead a minute after it stops", async () => {
    await db().execute(sql`delete from platform_ticks`);
    /* A platform whose worker never ran is not "down". */
    await expect(service.workerAlive()).resolves.toBeUndefined();
    const t0 = Date.now() + 5_400_000;
    clock.set(at(t0, 0));
    await service.platformTick();
    clock.set(at(t0, 59));
    await expect(service.workerAlive()).resolves.toBeUndefined();
    clock.set(at(t0, 61));
    await expect(service.workerAlive()).rejects.toThrow("the worker last ticked 61 s ago");
    await service.platformTick();
    await expect(service.workerAlive()).resolves.toBeUndefined();
  });

  it("a worker that stopped ticking records a gap when it comes back", async () => {
    const t0 = Date.now() + 7_200_000;
    clock.set(at(t0, 0));
    await service.platformTick();
    clock.set(at(t0, 300));
    await service.platformTick();
    const gaps = await rows<{ started_at: string; ended_at: string }>(
      sql`select started_at, ended_at from platform_gaps where reason = 'worker' order by started_at desc limit 1`,
    );
    expect(gaps.map((g) => [toDate(g.started_at), toDate(g.ended_at)])).toEqual([
      [at(t0, 0), at(t0, 300)],
    ]);
  });
});
