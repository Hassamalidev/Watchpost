/*
 * P2-T06 against the real container: dependencies and grouped alerts (§9.6). A parent outage with
 * ten children sends one alert; a child that is still down when the parent recovers is announced
 * then; and a group that asks for it gets one message for a burst of failures.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { v7 as uuidv7 } from "uuid";
import type { AlertingModule } from "../modules/alerting/index.js";
import type { DetectionModule } from "../modules/detection/index.js";
import type { ProbesModule } from "../modules/probes/index.js";
import type { ResultsModule } from "../modules/results/index.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  probeClient,
  signUpVerified,
  stubHttp,
} from "./helpers/container-app.js";

const http = stubHttp();
const ctx = buildContainerApp({ authRateLimit: false, http });
const run = randomBytes(4).toString("hex");
let owner: TestAgent;
let ws = "";
let detection: DetectionModule;
let alerting: AlertingModule;
let results: ResultsModule;
const planned = new Set<string>();

const api = (method: "get" | "post" | "patch" | "put", path: string) =>
  owner[method](`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN);

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await ctx.container.infra.db.execute(query)).rows as T[];
}

async function createMonitor(name: string, settings: Record<string, unknown> = {}) {
  const res = await api("post", "/monitors").send({
    settings: { name, regions: ["eu-central"], minFailingRegions: 1, ...settings },
    config: { type: "tcp", host: "example.com", port: 443 },
  });
  expect(res.status, res.text).toBe(201);
  return res.body.id as string;
}

async function report(monitorId: string, ok: boolean, secondsAgo: number) {
  await results.service.ingest([
    {
      id: uuidv7(),
      monitorId,
      workspaceId: ws,
      region: "eu-central",
      checkedAt: new Date(Date.now() - secondsAgo * 1_000).toISOString(),
      ok,
      latencyMs: 20,
      ...(ok ? {} : { errorCode: "connect_refused" }),
    },
  ]);
  await ctx.container.infra.db.execute(sql`
    insert into monitor_state (monitor_id, workspace_id, last_result_at)
    values (${monitorId}, ${ws}, now())
    on conflict (monitor_id) do update set last_result_at = now()`);
}

/* Two results in a row and an evaluation after each: enough to change the monitor's state. */
let tick = 1_000;
async function settle(monitorId: string, ok: boolean) {
  for (let i = 0; i < 2; i += 1) {
    tick -= 1;
    await report(monitorId, ok, tick);
    await detection.service.evaluateMonitor(monitorId);
  }
}

/* What the worker does with new `incident.triggered` events: plan the alert. */
async function planTriggered(): Promise<number> {
  const events = await rows<{ id: string; payload: { incidentId: string } }>(sql`
    select id, payload from outbox_events
    where workspace_id = ${ws} and type = 'incident.triggered' order by created_at, id`);
  let count = 0;
  for (const e of events) {
    if (planned.has(e.id)) continue;
    planned.add(e.id);
    count += await alerting.service.planIncidentEvent({
      kind: "triggered",
      incidentId: e.payload.incidentId,
      eventKey: e.id,
    });
  }
  return count;
}

/* Sends every delivery that is waiting, oldest first, and says how each ended. */
async function sendPending(): Promise<string[]> {
  const pending = await rows<{ id: string }>(sql`
    select id from notification_deliveries
    where workspace_id = ${ws} and status = 'pending' order by id`);
  const outcomes: string[] = [];
  for (const d of pending) outcomes.push(await alerting.service.deliver(d.id));
  return outcomes;
}

const sentTitles = () =>
  http.requests
    .filter((r) => r.url === "https://hooks.example.com/deps")
    .map((r) => JSON.parse(r.body ?? "{}") as { incident: { title: string }; group?: unknown });

const incidentOf = async (monitorId: string) => {
  const [row] = await rows<{ id: string; number: number; suppressed_by_incident_id: string | null }>(
    sql`select id, number, suppressed_by_incident_id from incidents
        where monitor_id = ${monitorId} and status <> 'resolved'`,
  );
  return row;
};

beforeAll(async () => {
  owner = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `deps-${run}@example.com`);
  const created = await owner
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "Dependencies Co", slug: `deps-${run}` });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id as string;

  const find = <T>(name: string) => ctx.container.modules.find((m) => m.name === name) as T;
  detection = find<DetectionModule>("detection");
  alerting = find<AlertingModule>("alerting");
  results = find<ResultsModule>("results");
  const creds = await find<ProbesModule>("probes").service.register({
    name: `deps-${run}`,
    region: "eu-central",
    kind: "managed",
  });
  const hello = await probeClient(ctx.app, creds).call("POST", "/hello", {
    version: "0.1.0",
    mode: "managed",
    region: "eu-central",
    capabilities: ["tcp"],
  });
  expect(hello.status, hello.text).toBe(200);

  const channel = await api("post", "/channels").send({
    type: "webhook",
    name: "Deps hook",
    config: { url: "https://hooks.example.com/deps" },
  });
  expect(channel.status, channel.text).toBe(201);
  const routed = await api("put", `/alert-policies/default/channels/${channel.body.id}`).send({});
  expect(routed.status, routed.text).toBe(200);
}, 120_000);

afterAll(async () => {
  await ctx.container.infra.db.execute(sql`delete from probe_tasks where workspace_id = ${ws}`);
  await ctx.container.close();
});

describe("dependencies", () => {
  let parent = "";
  const children: string[] = [];

  it("a parent outage with 10 children sends 1 alert", async () => {
    parent = await createMonitor("Database");
    for (let i = 0; i < 10; i += 1) {
      children.push(await createMonitor(`Service ${i}`, { parentId: parent }));
    }
    await settle(parent, false);
    for (const child of children) await settle(child, false);

    const parentIncident = await incidentOf(parent);
    expect(parentIncident?.suppressed_by_incident_id).toBeNull();
    for (const child of children) {
      expect((await incidentOf(child))?.suppressed_by_incident_id).toBe(parentIncident?.id);
    }

    expect(await planTriggered()).toBe(1);
    expect(await sendPending()).toEqual(["sent"]);
    expect(sentTitles().map((b) => b.incident.title)).toHaveLength(1);

    /* A suppressed incident says what explains it, and its timeline records why it was quiet. */
    const child = await incidentOf(children[0] ?? "");
    const detail = await api("get", `/incidents/${child?.number}`);
    expect(detail.status, detail.text).toBe(200);
    expect(detail.body.suppressedBy).toMatchObject({ number: parentIncident?.number });
    expect((detail.body.timeline as { type: string }[]).map((e) => e.type)).toEqual(
      expect.arrayContaining(["triggered", "suppressed"]),
    );
    /* Nothing goes out for it while it is quiet, whatever asks. */
    expect(
      await alerting.service.planIncidentEvent({
        kind: "reminder",
        incidentId: child?.id ?? "",
        eventKey: `reminder.${child?.id}.1`,
      }),
    ).toBe(0);
    expect(await alerting.service.startEscalation(child?.id ?? "")).toBe(false);
  }, 120_000);

  it("a child that recovers while suppressed stays quiet", async () => {
    const quiet = children[9] ?? "";
    const incident = await incidentOf(quiet);
    await settle(quiet, true);
    expect(await incidentOf(quiet)).toBeUndefined();
    expect(
      await alerting.service.planIncidentEvent({
        kind: "resolved",
        incidentId: incident?.id ?? "",
        eventKey: `resolved-${incident?.id}`,
      }),
    ).toBe(0);
  }, 60_000);

  it("when the parent recovers, children that are still down are announced", async () => {
    const before = sentTitles().length;
    await settle(parent, true);
    expect(await incidentOf(parent)).toBeUndefined();
    for (const child of children.slice(0, 9)) {
      expect((await incidentOf(child))?.suppressed_by_incident_id).toBeNull();
    }
    expect(await planTriggered()).toBe(9);
    expect((await sendPending()).filter((o) => o === "sent")).toHaveLength(9);
    expect(sentTitles().length - before).toBe(9);
  }, 120_000);

  it("looks up the whole chain: a grandchild is explained by the grandparent", async () => {
    const top = await createMonitor("Network");
    const middle = await createMonitor("Load balancer", { parentId: top });
    const leaf = await createMonitor("Checkout", { parentId: middle });
    await settle(top, false);
    await settle(middle, false);
    await settle(leaf, false);
    const topIncident = await incidentOf(top);
    expect((await incidentOf(middle))?.suppressed_by_incident_id).toBe(topIncident?.id);
    expect((await incidentOf(leaf))?.suppressed_by_incident_id).toBe(topIncident?.id);

    /* The top recovers: the middle one is announced, and now explains the leaf. */
    await settle(top, true);
    const middleIncident = await incidentOf(middle);
    expect(middleIncident?.suppressed_by_incident_id).toBeNull();
    expect((await incidentOf(leaf))?.suppressed_by_incident_id).toBe(middleIncident?.id);
    await planTriggered();
    await sendPending();
  }, 120_000);
});

describe("editing the links", () => {
  it("a PATCH with null removes the parent and the group", async () => {
    const group = await api("post", "/monitor-groups").send({ name: "Edge" });
    const parent = await createMonitor("Gateway");
    const child = await createMonitor("Behind the gateway", {
      parentId: parent,
      groupId: group.body.id,
    });
    const kept = await api("patch", `/monitors/${child}`).send({ settings: { name: "Renamed" } });
    expect(kept.body).toMatchObject({ parentId: parent, groupId: group.body.id });
    const cleared = await api("patch", `/monitors/${child}`).send({
      settings: { parentId: null, groupId: null },
    });
    expect(cleared.status, cleared.text).toBe(200);
    expect(cleared.body).toMatchObject({ name: "Renamed", parentId: null, groupId: null });
    /* A monitor can't depend on itself or on one that depends on it. */
    const loop = await api("patch", `/monitors/${parent}`).send({ settings: { parentId: parent } });
    expect(loop.status).toBe(400);
  });
});

describe("grouped alerts", () => {
  it("failures in a group within its window become one message", async () => {
    const group = await api("post", "/monitor-groups").send({
      name: "Production",
      groupAlerts: true,
    });
    expect(group.status, group.text).toBe(201);
    expect(group.body).toMatchObject({ name: "Production", groupAlerts: true });
    const members: string[] = [];
    for (const name of ["API", "Web", "Worker", "Cache"]) {
      members.push(await createMonitor(name, { groupId: group.body.id }));
    }
    const before = sentTitles().length;
    for (const m of members) await settle(m, false);
    expect(await planTriggered()).toBe(4);

    const waiting = await rows<{ group_key: string; due_in: number }>(sql`
      select group_key, extract(epoch from due_at - now())::int as due_in
      from notification_deliveries
      where workspace_id = ${ws} and status = 'pending'`);
    expect(new Set(waiting.map((w) => w.group_key)).size).toBe(1);
    for (const w of waiting) expect(w.due_in).toBeLessThanOrEqual(15);

    expect(await sendPending()).toEqual(["sent", "skipped", "skipped", "skipped"]);
    const [message] = sentTitles().slice(before);
    expect(sentTitles().length - before).toBe(1);
    expect(message?.group).toMatchObject({ name: "Production" });
    expect((message?.group as { incidents: unknown[] }).incidents).toHaveLength(3);
    const request = http.requests.at(-1);
    expect(request?.body).toContain("Production");

    /* The delivery log of a grouped incident says why it got no message of its own. */
    const skipped = await rows<{ error: string }>(sql`
      select error from notification_deliveries
      where workspace_id = ${ws} and status = 'skipped' and group_key is not null`);
    expect(skipped).toHaveLength(3);
    expect(skipped[0]?.error).toMatch(/one message/);

    /* A failure after the window closed starts a new one. */
    const late = await createMonitor("Queue", { groupId: group.body.id });
    await settle(late, false);
    expect(await planTriggered()).toBe(1);
    const keys = await rows<{ group_key: string }>(sql`
      select distinct group_key from notification_deliveries
      where workspace_id = ${ws} and group_key is not null`);
    expect(keys).toHaveLength(2);
    expect(await sendPending()).toEqual(["sent"]);
    expect(sentTitles().at(-1)?.group).toBeUndefined();
  }, 120_000);

  it("a group without the option alerts for each monitor at once", async () => {
    const group = await api("post", "/monitor-groups").send({ name: "Staging" });
    expect(group.body.groupAlerts).toBe(false);
    const a = await createMonitor("Staging API", { groupId: group.body.id });
    await settle(a, false);
    expect(await planTriggered()).toBe(1);
    const [row] = await rows<{ group_key: string | null; due_at: string | null }>(sql`
      select group_key, due_at from notification_deliveries
      where workspace_id = ${ws} and status = 'pending'`);
    expect(row).toEqual({ group_key: null, due_at: null });
    expect(await sendPending()).toEqual(["sent"]);

    const patched = await api("patch", `/monitor-groups/${group.body.id}`).send({
      name: "Staging",
      groupAlerts: true,
    });
    expect(patched.status, patched.text).toBe(200);
    expect(patched.body.groupAlerts).toBe(true);
  }, 60_000);
});
