/*
 * P2-T05 through the real API: planning maintenance windows, and what they do to detection. Inside a
 * window failures are recorded but open no incident; when it ends the monitor is evaluated again and
 * a real outage alerts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { v7 as uuidv7 } from "uuid";
import type { MaintenanceWindowView } from "@app/shared";
import type { DetectionModule } from "../modules/detection/index.js";
import type { MaintenanceModule } from "../modules/maintenance/index.js";
import type { ProbesModule } from "../modules/probes/index.js";
import type { ResultsModule } from "../modules/results/index.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  emailFromOutbox,
  probeClient,
  signUpVerified,
} from "./helpers/container-app.js";

let ctx: ReturnType<typeof buildContainerApp>;
let owner: TestAgent;
let viewer: TestAgent;
let ws: string;
let detection: DetectionModule;
let maintenance: MaintenanceModule;
let results: ResultsModule;

const as = (agent: TestAgent) => ({
  post: (path: string, body: object) => agent.post(path).set("Origin", WEB_ORIGIN).send(body),
  patch: (path: string, body: object) => agent.patch(path).set("Origin", WEB_ORIGIN).send(body),
  get: (path: string) => agent.get(path).set("Origin", WEB_ORIGIN),
  delete: (path: string) => agent.delete(path).set("Origin", WEB_ORIGIN),
});
const base = () => `/api/w/${ws}/maintenance-windows`;
const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await ctx.container.infra.db.execute(query)).rows as T[];
}

async function createMonitor(name: string): Promise<string> {
  const res = await as(owner).post(`/api/w/${ws}/monitors`, {
    settings: { name, regions: ["eu-central"], minFailingRegions: 1 },
    config: { type: "tcp", host: "example.com", port: 443 },
  });
  expect(res.status, res.text).toBe(201);
  return res.body.id as string;
}

async function fail(monitorId: string, secondsAgo: number) {
  await results.service.ingest([
    {
      id: uuidv7(),
      monitorId,
      workspaceId: ws,
      region: "eu-central",
      checkedAt: new Date(Date.now() - secondsAgo * 1_000).toISOString(),
      ok: false,
      latencyMs: 20,
      errorCode: "connect_refused",
    },
  ]);
  await ctx.container.infra.db.execute(sql`
    insert into monitor_state (monitor_id, workspace_id, last_result_at)
    values (${monitorId}, ${ws}, now())
    on conflict (monitor_id) do update set last_result_at = now()`);
}

const incidentsFor = (monitorId: string) =>
  rows<{ status: string }>(sql`select status from incidents where monitor_id = ${monitorId}`);

beforeAll(async () => {
  ctx = buildContainerApp({ authRateLimit: false });
  owner = request.agent(ctx.app);
  viewer = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `maint-${randomBytes(4).toString("hex")}@example.com`);
  const created = await as(owner).post("/api/auth/organization/create", {
    name: "Maintenance Co",
    slug: `maint-co-${randomBytes(4).toString("hex")}`,
  });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id;

  const viewerEmail = `maint-viewer-${randomBytes(4).toString("hex")}@example.com`;
  await signUpVerified(ctx, viewer, viewerEmail);
  await as(owner).post("/api/auth/organization/invite-member", {
    email: viewerEmail,
    role: "viewer",
    organizationId: ws,
  });
  const { url } = await emailFromOutbox(ctx.container, viewerEmail, "invite");
  await as(viewer).post("/api/auth/organization/accept-invitation", {
    invitationId: String(url).split("/").at(-1),
  });

  const find = <T>(name: string) => ctx.container.modules.find((m) => m.name === name) as T;
  detection = find<DetectionModule>("detection");
  maintenance = find<MaintenanceModule>("maintenance");
  results = find<ResultsModule>("results");
  const creds = await find<ProbesModule>("probes").service.register({
    name: `maint-${randomBytes(3).toString("hex")}`,
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
}, 120_000);

afterAll(async () => {
  await ctx.container.infra.db.execute(sql`delete from probe_tasks where workspace_id = ${ws}`);
  await ctx.container.infra.db.execute(
    sql`delete from maintenance_windows where workspace_id = ${ws}`,
  );
  await ctx.container.close();
});

describe("planning windows", () => {
  let id: string;

  it("creates a repeating window and says when it is next in effect", async () => {
    const res = await as(owner).post(base(), {
      name: "Nightly database backup",
      startsAt: hoursFromNow(24),
      endsAt: hoursFromNow(25),
      timezone: "Europe/Berlin",
      rrule: "freq=daily",
      scope: { all: true },
    });
    expect(res.status, res.text).toBe(201);
    const view = res.body as MaintenanceWindowView;
    id = view.id;
    expect(view).toMatchObject({
      rrule: "FREQ=DAILY",
      timezone: "Europe/Berlin",
      active: false,
      over: false,
      suppressAlerts: true,
      showOnPages: true,
    });
    expect(view.nextStart).toBe(view.startsAt);
    const list = await as(viewer).get(base());
    expect((list.body.data as MaintenanceWindowView[]).map((w) => w.id)).toContain(id);
  });

  it("names the field for a bad timezone, rule, time span or monitor", async () => {
    const window = {
      name: "Bad",
      startsAt: hoursFromNow(1),
      endsAt: hoursFromNow(2),
      scope: { all: true },
    };
    const cases: Array<[object, string]> = [
      [{ ...window, timezone: "Mars/Olympus" }, "body.timezone"],
      [{ ...window, rrule: "FREQ=HOURLY" }, "body.rrule"],
      [{ ...window, endsAt: window.startsAt }, "body.endsAt"],
      [{ ...window, endsAt: hoursFromNow(24 * 40) }, "body.endsAt"],
      [{ ...window, scope: { monitorIds: [uuidv7()] } }, "body.scope"],
    ];
    for (const [body, path] of cases) {
      const res = await as(owner).post(base(), body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((res.body.errors as Array<{ path: string }>)[0]?.path, res.text).toBe(path);
    }
  });

  it("viewers read; members and above change", async () => {
    expect((await as(viewer).patch(`${base()}/${id}`, { name: "Renamed" })).status).toBe(403);
    expect((await as(viewer).delete(`${base()}/${id}`)).status).toBe(403);
    const renamed = await as(owner).patch(`${base()}/${id}`, { name: "Nightly backup" });
    expect(renamed.body.name).toBe("Nightly backup");
    expect((await as(owner).delete(`${base()}/${id}`)).status).toBe(204);
    expect((await as(owner).get(`${base()}/${id}`)).status).toBe(404);
  });
});

describe("detection during maintenance", () => {
  it("records failures but opens no incident, then alerts once the window is gone", async () => {
    const inWindow = await createMonitor("Planned work");
    const outside = await createMonitor("Not covered");
    const created = await as(owner).post(base(), {
      name: "Database upgrade",
      startsAt: hoursFromNow(-1),
      endsAt: hoursFromNow(1),
      scope: { monitorIds: [inWindow] },
    });
    expect(created.status, created.text).toBe(201);
    expect(created.body).toMatchObject({ active: true, nextStart: null });
    const windowId = created.body.id as string;

    /* The sweep reports the start once. */
    const started = (await maintenance.service.boundaryChanges()).filter(
      (c) => c.windowId === windowId,
    );
    expect(started).toEqual([
      { workspaceId: ws, windowId, monitorIds: [inWindow], change: "started" },
    ]);
    expect(
      (await maintenance.service.boundaryChanges()).filter((c) => c.windowId === windowId),
    ).toEqual([]);

    for (const monitorId of [inWindow, outside]) {
      await fail(monitorId, 20);
      await detection.service.evaluateMonitor(monitorId);
      await fail(monitorId, 5);
    }
    const quiet = await detection.service.evaluateMonitor(inWindow);
    const loud = await detection.service.evaluateMonitor(outside);
    expect(quiet?.decision).toMatchObject({ status: "maintenance", openIncident: false });
    expect(await incidentsFor(inWindow)).toEqual([]);
    expect(loud?.decision.status).toBe("down");
    expect(await incidentsFor(outside)).toHaveLength(1);
    /* The time is on record as maintenance, so uptime can leave it out. */
    const downtimes = await rows<{ kind: string }>(
      sql`select kind from downtimes where monitor_id = ${inWindow}`,
    );
    expect(downtimes).toEqual([{ kind: "maintenance" }]);

    /* The window is deleted while the monitor is still failing: the next look alerts. */
    expect((await as(owner).delete(`${base()}/${windowId}`)).status).toBe(204);
    const [state] = await rows<{ status: string }>(
      sql`select status from monitor_state where monitor_id = ${inWindow}`,
    );
    expect(state).toEqual({ status: "maintenance" });
    /* The sweep finds it by its status and queues it; evaluating it is what the job would do. */
    expect(await detection.service.sweep()).toBeGreaterThanOrEqual(1);
    await fail(inWindow, 0);
    await detection.service.evaluateMonitor(inWindow);
    await fail(inWindow, -1);
    const after = await detection.service.evaluateMonitor(inWindow);
    expect(after?.decision.status).toBe("down");
    expect(await incidentsFor(inWindow)).toHaveLength(1);
  }, 60_000);

  it("an informational window (alerts not silenced) changes nothing", async () => {
    const monitorId = await createMonitor("Informational");
    const created = await as(owner).post(base(), {
      name: "Heads-up only",
      startsAt: hoursFromNow(-1),
      endsAt: hoursFromNow(1),
      scope: { all: true },
      suppressAlerts: false,
    });
    expect(created.status, created.text).toBe(201);
    expect(
      await maintenance.service.inMaintenance({ id: monitorId, workspaceId: ws }, new Date()),
    ).toBe(false);
    const changes = await maintenance.service.boundaryChanges();
    expect(changes.filter((c) => c.windowId === created.body.id)).toEqual([]);
  });

  it("a window that is over is marked finished and never looked at again", async () => {
    const created = await as(owner).post(base(), {
      name: "Last week",
      startsAt: hoursFromNow(-48),
      endsAt: hoursFromNow(-47),
      scope: { all: true },
    });
    expect(created.body).toMatchObject({ active: false, over: true, nextStart: null });
    await maintenance.service.boundaryChanges();
    const [row] = await rows<{ finished: boolean }>(
      sql`select finished_at is not null as finished from maintenance_windows where id = ${created.body.id}`,
    );
    expect(row).toEqual({ finished: true });
  });
});
