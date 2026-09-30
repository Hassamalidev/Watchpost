/*
 * P1-T16 AC: rollups are idempotent (re-running changes nothing; late results are absorbed on the
 * next run) and every level adds up; chart and uptime endpoints serve them per workspace.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { v7 as uuidv7 } from "uuid";
import { createFakeClock } from "../../../core/clock.js";
import { newId } from "../../../infra/ids.js";
import type { MonitorsModule } from "../../monitors/index.js";
import type { ResultsModule } from "../index.js";
import { createResultsRepository } from "../results.repository.js";
import { createRollupsService, type RollupsService } from "../rollups.service.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  signUpVerified,
} from "../../../__tests__/helpers/container-app.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let ctx: ReturnType<typeof buildContainerApp>;
let owner: TestAgent;
let stranger: TestAgent;
let ws: string;
let monitorId: string;
let rollups: RollupsService;
const clock = createFakeClock();
/* A complete 5-minute bucket 30–35 minutes ago. */
const bucket = Math.floor((Date.now() - 35 * MIN) / (5 * MIN)) * 5 * MIN;

const db = () => ctx.container.infra.db;
const get = (agent: TestAgent, path: string) => agent.get(path).set("Origin", WEB_ORIGIN);

async function workspace(agent: TestAgent, name: string) {
  const res = await agent
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({
      name,
      slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomBytes(4).toString("hex")}`,
    });
  expect(res.status, res.text).toBe(200);
  return res.body.id as string;
}

async function report(
  entries: Array<{ offsetSec: number; latencyMs: number; ok?: boolean; region?: string }>,
) {
  const results = ctx.container.modules.find((m) => m.name === "results") as ResultsModule;
  const outcome = await results.service.ingest(
    entries.map((e) => ({
      id: uuidv7(),
      monitorId,
      workspaceId: ws,
      region: (e.region ?? "eu-central") as "eu-central",
      checkedAt: new Date(bucket + e.offsetSec * 1_000).toISOString(),
      ok: e.ok ?? true,
      latencyMs: e.latencyMs,
      ...(e.ok === false ? { errorCode: "connect_timeout" as const } : {}),
    })),
  );
  expect(outcome.accepted).toBe(entries.length);
}

const rollupRows = (table: "rollups_5m" | "rollups_1h" | "rollups_1d") =>
  db()
    .execute<{
      region: string;
      bucket: string;
      count: number;
      fail_count: number;
      ok_count: number;
      latency_sum: string;
      latency_min: number;
      latency_max: number;
      histogram: number[];
    }>(
      sql`select region, bucket, count, fail_count, ok_count, latency_sum, latency_min, latency_max, histogram
          from ${sql.identifier(table)} where monitor_id = ${monitorId} order by region, bucket`,
    )
    .then((r) => r.rows.map((row) => ({ ...row, bucket: new Date(row.bucket).toISOString() })));

beforeAll(async () => {
  ctx = buildContainerApp({ authRateLimit: false });
  owner = request.agent(ctx.app);
  stranger = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `roll-owner-${randomBytes(4).toString("hex")}@example.com`);
  ws = await workspace(owner, "Charts Co");
  await signUpVerified(ctx, stranger, `roll-other-${randomBytes(4).toString("hex")}@example.com`);
  await workspace(stranger, "Other Co");

  const created = await owner
    .post(`/api/w/${ws}/monitors`)
    .set("Origin", WEB_ORIGIN)
    .send({
      settings: { name: "API", regions: ["eu-central", "us-east"] },
      config: { type: "tcp", host: "example.com", port: 443 },
    });
  expect(created.status, created.text).toBe(201);
  monitorId = created.body.id;

  const monitors = ctx.container.modules.find((m) => m.name === "monitors") as MonitorsModule;
  rollups = createRollupsService({
    repository: createResultsRepository(db()),
    monitors: monitors.service,
    clock,
  });

  /* eu-central: 6 successes (20…70 ms) and a failure; us-east: 3 successes (100, 200, 300 ms). */
  await report([
    ...[20, 30, 40, 50, 60, 70].map((latencyMs, i) => ({ offsetSec: i * 30, latencyMs })),
    { offsetSec: 200, latencyMs: 10_000, ok: false },
    ...[100, 200, 300].map((latencyMs, i) => ({ offsetSec: i * 60, latencyMs, region: "us-east" })),
  ]);
});

afterAll(async () => {
  await ctx.container.close();
});

describe("rollups", () => {
  it("5-minute rollups count, summarize and bucket latencies, and re-running changes nothing", async () => {
    clock.set(new Date(bucket + 40 * MIN));
    await rollups.rollup("5m");
    const first = await rollupRows("rollups_5m");
    expect(first).toEqual([
      expect.objectContaining({
        region: "eu-central",
        bucket: new Date(bucket).toISOString(),
        count: 7,
        fail_count: 1,
        ok_count: 6,
        latency_sum: "270",
        latency_min: 20,
        latency_max: 70,
      }),
      expect.objectContaining({ region: "us-east", count: 3, fail_count: 0, latency_sum: "600" }),
    ]);
    expect(first[0]?.histogram.reduce((a, b) => a + b, 0)).toBe(6);

    await rollups.rollup("5m");
    expect(await rollupRows("rollups_5m")).toEqual(first);
  });

  it("absorbs a late result on the next run", async () => {
    await report([{ offsetSec: 250, latencyMs: 80 }]);
    await rollups.rollup("5m");
    const [eu] = await rollupRows("rollups_5m");
    expect(eu).toMatchObject({ count: 8, ok_count: 7, latency_sum: "350", latency_max: 80 });
  });

  it("hourly and daily rollups add up to the 5-minute ones, idempotently", async () => {
    const hourStart = Math.floor(bucket / HOUR) * HOUR;
    clock.set(new Date(hourStart + HOUR + MIN));
    await rollups.rollup("1h");
    await rollups.rollup("1h");
    const hourly = await rollupRows("rollups_1h");
    const fiveMinute = await rollupRows("rollups_5m");
    expect(hourly.map((r) => [r.region, r.bucket, r.count, r.fail_count, r.latency_sum])).toEqual(
      fiveMinute.map((r) => [
        r.region,
        new Date(hourStart).toISOString(),
        r.count,
        r.fail_count,
        r.latency_sum,
      ]),
    );
    expect(hourly.map((r) => r.histogram)).toEqual(fiveMinute.map((r) => r.histogram));

    const dayStart = Math.floor(bucket / DAY) * DAY;
    clock.set(new Date(dayStart + DAY + MIN));
    await rollups.rollup("1d");
    await rollups.rollup("1d");
    const daily = await rollupRows("rollups_1d");
    expect(daily.map((r) => [r.region, r.bucket, r.count, r.latency_min, r.latency_max])).toEqual(
      hourly.map((r) => [
        r.region,
        new Date(dayStart).toISOString(),
        r.count,
        r.latency_min,
        r.latency_max,
      ]),
    );
  }, 30_000);
});

describe("chart endpoints", () => {
  it("serves latency percentiles from rollups, merged across regions or per region", async () => {
    const all = await get(owner, `/api/w/${ws}/monitors/${monitorId}/latency?range=24h`);
    expect(all.status, all.text).toBe(200);
    expect(all.body).toMatchObject({ range: "24h", resolution: "5m", region: null });
    const point = all.body.points.find(
      (p: { bucket: string }) => p.bucket === new Date(bucket).toISOString(),
    );
    expect(point).toMatchObject({ count: 11, failCount: 1, avgMs: 95 });
    expect(point.p50).toBeGreaterThanOrEqual(50);
    expect(point.p50).toBeLessThanOrEqual(75);
    expect(point.p99).toBeGreaterThanOrEqual(200);

    const us = await get(
      owner,
      `/api/w/${ws}/monitors/${monitorId}/latency?range=24h&region=us-east`,
    );
    expect(us.body.summary).toMatchObject({ count: 3, avgMs: 200 });
    expect((await get(owner, `/api/w/${ws}/monitors/${monitorId}/latency?range=2y`)).status).toBe(
      400,
    );
  });

  it("lists raw checks newest first", async () => {
    const res = await get(owner, `/api/w/${ws}/monitors/${monitorId}/checks?limit=5`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(5);
    const times = res.body.data.map((c: { checkedAt: string }) => c.checkedAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it("serves uptime from downtimes", async () => {
    /* Uptime ignores time before the monitor existed; pretend it was created two days ago. */
    await db().execute(
      sql`update monitors set created_at = now() - interval '2 days' where id = ${monitorId}`,
    );
    const outageStart = new Date(Date.now() - 2 * HOUR);
    await db().execute(sql`
      insert into downtimes (id, workspace_id, monitor_id, kind, started_at, ended_at)
      values (${newId()}, ${ws}, ${monitorId}, 'outage', ${outageStart.toISOString()}::timestamptz,
        ${new Date(outageStart.getTime() + 36 * MIN).toISOString()}::timestamptz)`);
    const from = new Date(outageStart.getTime() - HOUR).toISOString();
    const to = new Date(outageStart.getTime() + 11 * HOUR).toISOString();
    const res = await get(
      owner,
      `/api/w/${ws}/monitors/${monitorId}/uptime?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    expect(res.status, res.text).toBe(200);
    expect(res.body.downtimeSeconds).toBe(2_160);
    expect(res.body.uptimePercent).toBeLessThan(100);

    const days = await get(owner, `/api/w/${ws}/monitors/${monitorId}/uptime/days?days=3`);
    expect(days.body.data).toHaveLength(3);
    expect(days.body.data.at(-1).downtimeSeconds).toBeGreaterThan(0);
  });

  it("other workspaces can't read charts", async () => {
    expect((await get(stranger, `/api/w/${ws}/monitors/${monitorId}/latency`)).status).toBe(404);
    expect((await get(stranger, `/api/w/${ws}/monitors/${monitorId}/uptime`)).status).toBe(404);
  });
});
