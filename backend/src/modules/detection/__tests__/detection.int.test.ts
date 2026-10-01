/*
 * P1-T10 through the real composition and database: an outage opens exactly one incident and an
 * outage downtime, recovery resolves both, multi-region verification creates tasks in the other
 * regions, concurrent evaluations can't duplicate an incident, the fast path skips evaluation, and
 * the sweep finds results no evaluation has seen.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { v7 as uuidv7 } from "uuid";
import type { IncidentsModule } from "../../incidents/index.js";
import type { ProbesModule } from "../../probes/index.js";
import type { ResultsModule } from "../../results/index.js";
import type { DetectionModule } from "../index.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  probeClient,
  signUpVerified,
} from "../../../__tests__/helpers/container-app.js";

let ctx: ReturnType<typeof buildContainerApp>;
let owner: TestAgent;
let ws: string;
let detection: DetectionModule;
let results: ResultsModule;
let euProbe: { id: string; secret: string };

const post = (path: string, body: object) => owner.post(path).set("Origin", WEB_ORIGIN).send(body);

async function createMonitor(name: string, settings: object = {}) {
  const res = await post(`/api/w/${ws}/monitors`, {
    settings: { name, regions: ["eu-central"], ...settings },
    config: { type: "tcp", host: "example.com", port: 443 },
  });
  expect(res.status, res.text).toBe(201);
  return res.body.id as string;
}

async function report(
  monitorId: string,
  entries: Array<{
    ok: boolean;
    secondsAgo: number;
    region?: "eu-central" | "us-east" | "ap-southeast";
    code?: string;
  }>,
) {
  const outcome = await results.service.ingest(
    entries.map((e) => ({
      id: uuidv7(),
      monitorId,
      workspaceId: ws,
      region: e.region ?? "eu-central",
      checkedAt: new Date(Date.now() - e.secondsAgo * 1_000).toISOString(),
      ok: e.ok,
      latencyMs: 20,
      ...(e.ok ? {} : { errorCode: (e.code ?? "connect_refused") as "connect_refused" }),
    })),
  );
  expect(outcome.accepted).toBe(entries.length);
  /* What ingest records before evaluation (the recovery sweep relies on it). */
  const newest = Math.min(...entries.map((e) => e.secondsAgo));
  await ctx.container.infra.db.execute(sql`
    insert into monitor_state (monitor_id, workspace_id, last_result_at)
    values (${monitorId}, ${ws}, ${new Date(Date.now() - newest * 1_000).toISOString()}::timestamptz)
    on conflict (monitor_id) do update set last_result_at =
      greatest(monitor_state.last_result_at, excluded.last_result_at)`);
}

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await ctx.container.infra.db.execute(query)).rows as T[];
}

const incidentsFor = (monitorId: string) =>
  rows<{ id: string; status: string; number: number; auto_resolved: boolean; cause_code: string }>(
    sql`select id, status, number, auto_resolved, cause_code from incidents where monitor_id = ${monitorId} order by started_at`,
  );
const downtimesFor = (monitorId: string) =>
  rows<{ kind: string; started_at: Date; ended_at: Date | null; incident_id: string | null }>(
    sql`select kind, started_at, ended_at, incident_id from downtimes where monitor_id = ${monitorId} order by started_at`,
  );
const eventsFor = (monitorId: string) =>
  rows<{ type: string; payload: Record<string, unknown> }>(
    sql`select type, payload from outbox_events where payload->>'monitorId' = ${monitorId} order by created_at, id`,
  );

beforeAll(async () => {
  ctx = buildContainerApp();
  owner = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `detect-${randomBytes(4).toString("hex")}@example.com`);
  const created = await post("/api/auth/organization/create", {
    name: "Detect Co",
    slug: `detect-co-${randomBytes(4).toString("hex")}`,
  });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id;

  const find = <T>(name: string) => ctx.container.modules.find((m) => m.name === name) as T;
  detection = find<DetectionModule>("detection");
  results = find<ResultsModule>("results");
  const probes = find<ProbesModule>("probes");
  /* Healthy probes in three regions (seen just now). */
  for (const region of ["eu-central", "us-east", "ap-southeast"] as const) {
    const creds = await probes.service.register({
      name: `detect-${region}-${randomBytes(3).toString("hex")}`,
      region,
      kind: "managed",
    });
    if (region === "eu-central") euProbe = creds;
    const hello = await probeClient(ctx.app, creds).call("POST", "/hello", {
      version: "0.1.0",
      mode: "managed",
      region,
      capabilities: ["tcp"],
    });
    expect(hello.status, hello.text).toBe(200);
  }
});

afterAll(async () => {
  /* Unclaimed verify tasks would be handed to other test files' probes in the same region. */
  await ctx.container.infra.db.execute(sql`delete from probe_tasks where workspace_id = ${ws}`);
  await ctx.container.close();
});

describe("single-region outage lifecycle", () => {
  let monitorId: string;

  it("goes up on the first success", async () => {
    monitorId = await createMonitor("Checkout API", { severity: "critical" });
    await report(monitorId, [{ ok: true, secondsAgo: 60 }]);
    const outcome = await detection.service.evaluateMonitor(monitorId);
    expect(outcome?.decision.status).toBe("up");
  });

  it("verifies a first failure in the same region instead of alerting", async () => {
    await report(monitorId, [{ ok: false, secondsAgo: 30 }]);
    const outcome = await detection.service.evaluateMonitor(monitorId);
    expect(outcome?.decision).toMatchObject({
      status: "verifying",
      verify: { regions: ["eu-central"], sameRegion: true },
    });
    expect(await incidentsFor(monitorId)).toHaveLength(0);

    /* The delayed same-region re-check creates a verify task for the region. */
    const tasks = await detection.service.requestVerification({
      kind: "verify",
      monitorId,
      workspaceId: ws,
      regions: ["eu-central"],
    });
    expect(tasks).toHaveLength(1);
  });

  it("opens exactly one incident and an outage when the failure is confirmed", async () => {
    await report(monitorId, [{ ok: false, secondsAgo: 25, code: "connect_timeout" }]);
    const outcome = await detection.service.evaluateMonitor(monitorId);
    expect(outcome?.decision.status).toBe("down");

    const incidents = await incidentsFor(monitorId);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ status: "triggered", cause_code: "connect_timeout" });
    expect(incidents[0]?.number).toBeGreaterThanOrEqual(1);

    const downtimes = await downtimesFor(monitorId);
    expect(downtimes).toHaveLength(1);
    expect(downtimes[0]).toMatchObject({
      kind: "outage",
      ended_at: null,
      incident_id: incidents[0]?.id,
    });

    const state = await detection.service.state(monitorId);
    expect(state).toMatchObject({ status: "down", openIncidentId: incidents[0]?.id });
    expect(state?.lastEvaluatedAt).toEqual(state?.lastResultAt);

    const types = (await eventsFor(monitorId)).map((e) => e.type);
    expect(types).toContain("incident.triggered");
    expect(types.filter((t) => t === "monitor.state_changed").length).toBeGreaterThanOrEqual(3);
  });

  it("a re-evaluation while still down changes nothing", async () => {
    await detection.service.evaluateMonitor(monitorId);
    expect(await incidentsFor(monitorId)).toHaveLength(1);
    expect(await downtimesFor(monitorId)).toHaveLength(1);
  });

  it("recovery resolves the incident and closes the downtime at the first success", async () => {
    await report(monitorId, [{ ok: true, secondsAgo: 10 }]);
    const outcome = await detection.service.evaluateMonitor(monitorId);
    expect(outcome?.decision.status).toBe("up");

    const [incident] = await incidentsFor(monitorId);
    expect(incident).toMatchObject({ status: "resolved", auto_resolved: true });
    const [downtime] = await downtimesFor(monitorId);
    expect(downtime?.ended_at).not.toBeNull();
    expect(new Date(downtime?.ended_at ?? 0).getTime()).toBeGreaterThan(
      new Date(downtime?.started_at ?? 0).getTime(),
    );
    const resolved = await rows<{ payload: { auto: boolean } }>(
      sql`select payload from outbox_events where type = 'incident.resolved' and payload->>'incidentId' = ${incident?.id}`,
    );
    expect(resolved.map((r) => r.payload.auto)).toEqual([true]);
    const timeline = await rows<{ type: string }>(
      sql`select type from incident_events where incident_id = ${incident?.id} order by at`,
    );
    expect(timeline.map((t) => t.type)).toEqual(["triggered", "resolved"]);
  });
});

describe("multi-region verification", () => {
  let monitorId: string;

  it("asks the other region to verify, then calls a healthy answer a regional issue", async () => {
    monitorId = await createMonitor("Global API", {
      regions: ["eu-central", "us-east"],
      minFailingRegions: 2,
    });
    await report(monitorId, [{ ok: true, secondsAgo: 60, region: "us-east" }]);
    await report(monitorId, [{ ok: false, secondsAgo: 5 }]);
    const first = await detection.service.evaluateMonitor(monitorId);
    expect(first?.decision).toMatchObject({
      status: "verifying",
      verify: { regions: ["us-east"], sameRegion: false },
    });
    const tasks = await rows<{ region: string; kind: string }>(
      sql`select region, kind from probe_tasks where monitor_id = ${monitorId}`,
    );
    expect(tasks).toEqual([{ region: "us-east", kind: "verify" }]);

    await report(monitorId, [{ ok: true, secondsAgo: -1, region: "us-east" }]);
    const second = await detection.service.evaluateMonitor(monitorId);
    expect(second?.decision).toMatchObject({
      status: "degraded",
      reason: "Regional issue: eu-central only",
    });
    expect(await incidentsFor(monitorId)).toHaveLength(0);
    expect((await downtimesFor(monitorId)).map((d) => d.kind)).toEqual(["degraded"]);
  });

  it("goes down once the failure reaches the required regions", async () => {
    await report(monitorId, [{ ok: false, secondsAgo: -2, region: "us-east" }]);
    const outcome = await detection.service.evaluateMonitor(monitorId);
    expect(outcome?.decision.status).toBe("down");
    expect(await incidentsFor(monitorId)).toHaveLength(1);
    const downtimes = await downtimesFor(monitorId);
    expect(downtimes.map((d) => [d.kind, d.ended_at === null])).toEqual([
      ["degraded", false],
      ["outage", true],
    ]);
  });
});

describe("three regions (P2-T02)", () => {
  const THREE = ["eu-central", "us-east", "ap-southeast"] as const;
  const healthy = (monitorId: string, secondsAgo: number) =>
    report(
      monitorId,
      THREE.map((region) => ({ ok: true, secondsAgo, region })),
    );

  it("1 of 3 failing is a regional issue and pages nobody", async () => {
    const monitorId = await createMonitor("Three A", { regions: THREE, minFailingRegions: 2 });
    await healthy(monitorId, 60);
    await report(monitorId, [{ ok: false, secondsAgo: 5 }]);
    const first = await detection.service.evaluateMonitor(monitorId);
    expect(first?.decision.verify?.regions).toEqual(["us-east", "ap-southeast"]);
    await report(monitorId, [
      { ok: true, secondsAgo: -1, region: "us-east" },
      { ok: true, secondsAgo: -1, region: "ap-southeast" },
    ]);
    const second = await detection.service.evaluateMonitor(monitorId);
    expect(second?.decision).toMatchObject({ status: "degraded", regionalIssue: true });
    expect(await incidentsFor(monitorId)).toHaveLength(0);
  });

  it("1 of 3 failing opens a low-severity incident when regional issues are alerted", async () => {
    const monitorId = await createMonitor("Three B", {
      regions: THREE,
      minFailingRegions: 2,
      alertOnRegionalIssue: true,
      severity: "critical",
    });
    await healthy(monitorId, 60);
    await report(monitorId, [{ ok: false, secondsAgo: 5 }]);
    await detection.service.evaluateMonitor(monitorId);
    await report(monitorId, [
      { ok: true, secondsAgo: -1, region: "us-east" },
      { ok: true, secondsAgo: -1, region: "ap-southeast" },
    ]);
    await detection.service.evaluateMonitor(monitorId);
    const incidents = await rows<{ title: string; severity: string; status: string }>(
      sql`select title, severity, status from incidents where monitor_id = ${monitorId}`,
    );
    expect(incidents).toEqual([
      { title: "Three B is failing from eu-central", severity: "low", status: "triggered" },
    ]);

    /* The region recovers: the incident resolves on its own. */
    await report(monitorId, [
      { ok: true, secondsAgo: -2 },
      { ok: true, secondsAgo: -3 },
    ]);
    const recovered = await detection.service.evaluateMonitor(monitorId);
    expect(recovered?.decision.status).toBe("up");
    expect((await incidentsFor(monitorId)).map((i) => i.status)).toEqual(["resolved"]);
  });

  it("2 of 3 and 3 of 3 failing open one incident with the failing regions", async () => {
    for (const failing of [2, 3]) {
      const monitorId = await createMonitor(`Three ${failing}`, {
        regions: THREE,
        minFailingRegions: 2,
      });
      await healthy(monitorId, 60);
      await report(
        monitorId,
        THREE.slice(0, failing).map((region) => ({ ok: false, secondsAgo: 2, region })),
      );
      const outcome = await detection.service.evaluateMonitor(monitorId);
      expect(outcome?.decision.status).toBe("down");
      expect(outcome?.decision.failingRegions).toEqual(THREE.slice(0, failing));
      expect(await incidentsFor(monitorId)).toHaveLength(1);
    }
  });

  it("measures the time from the confirming result to the open incident", async () => {
    const samples: number[] = [];
    for (let i = 0; i < 15; i += 1) {
      const monitorId = await createMonitor(`Latency ${i}`, {
        regions: THREE,
        minFailingRegions: 2,
      });
      await healthy(monitorId, 60);
      await report(monitorId, [{ ok: false, secondsAgo: 3 }]);
      await detection.service.evaluateMonitor(monitorId);
      const started = performance.now();
      await report(monitorId, [{ ok: false, secondsAgo: 0, region: "us-east" }]);
      const outcome = await detection.service.evaluateMonitor(monitorId);
      samples.push(performance.now() - started);
      expect(outcome?.decision.openIncident).toBe(true);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)] ?? 0;
    process.stdout.write(
      `detection latency (ingest + evaluate, ms): median ${median.toFixed(0)}, max ${(samples.at(-1) ?? 0).toFixed(0)}
`,
    );
    /* The pipeline's share of the §9.2 budget (verification 3–8 s, notification ≤ 5 s). */
    expect(median).toBeLessThan(2_000);
  }, 60_000);
});

describe("concurrency", () => {
  it("parallel evaluations open exactly one incident", async () => {
    const monitorId = await createMonitor("Parallel");
    await report(monitorId, [
      { ok: false, secondsAgo: 20 },
      { ok: false, secondsAgo: 10 },
    ]);
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () => detection.service.evaluateMonitor(monitorId)),
    );
    expect(outcomes.every((o) => o?.decision.status === "down")).toBe(true);
    expect(await incidentsFor(monitorId)).toHaveLength(1);
    expect(await downtimesFor(monitorId)).toHaveLength(1);
  });

  it("the unique index stops duplicates even without the state lock", async () => {
    const monitorId = await createMonitor("Race");
    const incidents = ctx.container.modules.find((m) => m.name === "incidents") as IncidentsModule;
    const attempts = await Promise.all(
      Array.from({ length: 5 }, () =>
        ctx.container.infra.db.transaction((tx) =>
          incidents.service.openForMonitor(tx, {
            workspaceId: ws,
            monitorId,
            title: "Race is down",
            severity: "high",
            causeCode: "connect_refused",
            failingRegions: ["eu-central"],
          }),
        ),
      ),
    );
    expect(attempts.filter((a) => a.created)).toHaveLength(1);
    expect(new Set(attempts.map((a) => a.incident.id)).size).toBe(1);
    expect(await incidentsFor(monitorId)).toHaveLength(1);
  });
});

describe("fast path and sweep", () => {
  it("healthy results for an up monitor skip evaluation", async () => {
    const monitorId = await createMonitor("Fast");
    await report(monitorId, [{ ok: true, secondsAgo: 30 }]);
    await detection.service.evaluateMonitor(monitorId);

    const client = probeClient(ctx.app, euProbe);
    const res = await client.call("POST", "/results", {
      batchId: uuidv7(),
      results: [
        {
          id: uuidv7(),
          monitorId,
          region: "eu-central",
          checkedAt: new Date().toISOString(),
          ok: true,
          latencyMs: 15,
        },
      ],
    });
    expect(res.status, res.text).toBe(202);
    const state = await detection.service.state(monitorId);
    expect(state?.status).toBe("up");
    expect(state?.lastEvaluatedAt).toEqual(state?.lastResultAt);
    const [region] = await rows<{ status: string; last_latency_ms: number }>(
      sql`select status, last_latency_ms from monitor_region_state where monitor_id = ${monitorId}`,
    );
    expect(region).toEqual({ status: "up", last_latency_ms: 15 });
  });

  it("the sweep finds results that were never evaluated", async () => {
    const monitorId = await createMonitor("Swept");
    await report(monitorId, [{ ok: false, secondsAgo: 5 }]);
    const unevaluated = await rows<{ monitor_id: string }>(
      sql`select monitor_id from monitor_state where last_result_at > coalesce(last_evaluated_at, '-infinity'::timestamptz)`,
    );
    expect(unevaluated.map((r) => r.monitor_id)).toContain(monitorId);
    expect(await detection.service.sweep()).toBeGreaterThanOrEqual(1);

    await detection.service.evaluateMonitor(monitorId);
    const state = await detection.service.state(monitorId);
    expect(state?.lastEvaluatedAt).toEqual(state?.lastResultAt);
  });
});

describe("manual incidents", () => {
  it("detection doesn't auto-resolve an incident a person opened", async () => {
    const monitorId = await createMonitor("Manual");
    const created = await post(`/api/w/${ws}/incidents`, { title: "Investigating", monitorId });
    expect(created.status, created.text).toBe(201);

    await report(monitorId, [{ ok: true, secondsAgo: 5 }]);
    const outcome = await detection.service.evaluateMonitor(monitorId);
    expect(outcome?.decision.status).toBe("up");
    const incidents = await incidentsFor(monitorId);
    expect(incidents.map((i) => i.status)).toEqual(["triggered"]);
  });
});
