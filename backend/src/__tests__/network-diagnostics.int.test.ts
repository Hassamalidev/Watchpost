/*
 * P8-T04 through the real API: when an incident opens, the failing region is asked to trace the
 * network. Only a probe that says it can is handed the task; what it reports lands on the
 * incident's timeline, once, and only from the probe that was asked.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { v7 as uuidv7 } from "uuid";
import type { CheckResult, NetworkDiagnostics, ProbeTask } from "@app/shared";
import type { AuthenticatedProbe } from "../middleware/probe-auth.js";
import type { DetectionModule } from "../modules/detection/index.js";
import type { ProbesModule } from "../modules/probes/index.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  probeClient,
  signUpVerified,
} from "./helpers/container-app.js";

let ctx: ReturnType<typeof buildContainerApp>;
let owner: TestAgent;
let ws = "";
let detection: DetectionModule;
let probe: AuthenticatedProbe;
let other: AuthenticatedProbe;
let client: ReturnType<typeof probeClient>;
let otherClient: ReturnType<typeof probeClient>;
const run = randomBytes(4).toString("hex");

const api = (method: "get" | "post", path: string) =>
  owner[method](`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN);

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await ctx.container.infra.db.execute(query)).rows as T[];
}

async function createMonitor(name: string, config: object): Promise<string> {
  const res = await api("post", "/monitors").send({
    settings: { name, regions: ["eu-west"], minFailingRegions: 1 },
    config,
  });
  expect(res.status, res.text).toBe(201);
  return res.body.id as string;
}

const refused = (monitorId: string, secondsAgo: number): CheckResult => ({
  id: uuidv7(),
  monitorId,
  region: "eu-west",
  checkedAt: new Date(Date.now() - secondsAgo * 1_000).toISOString(),
  ok: false,
  errorCode: "connect_timeout",
  message: "connection timed out",
  latencyMs: 10_000,
});

/* Two failures confirm a single-region outage: the incident opens on the second. */
async function outage(monitorId: string): Promise<string> {
  await ctx.container.infra.db.execute(
    sql`update probes set last_seen_at = now() where id = ${probe.id}`,
  );
  for (const secondsAgo of [20, 5]) {
    await detection.service.ingest(probe, {
      batchId: uuidv7(),
      results: [refused(monitorId, secondsAgo)],
    });
    await detection.service.evaluateMonitor(monitorId);
  }
  const [incident] = await rows<{ id: string }>(
    sql`select id from incidents where monitor_id = ${monitorId} and resolved_at is null`,
  );
  expect(incident, "the incident opened").toBeDefined();
  return incident?.id ?? "";
}

const diagnostics: NetworkDiagnostics = {
  host: "shop.example.com",
  address: "203.0.113.9",
  traceroute: {
    tool: "tracepath",
    hops: [
      { hop: 1, ip: "192.0.2.1", rttMs: 0.4 },
      { hop: 2, ip: null, rttMs: null },
      { hop: 3, ip: "198.51.100.7", rttMs: 12.5 },
    ],
    reached: false,
  },
  dnsTrace: {
    name: "shop.example.com",
    steps: [
      {
        zone: ".",
        server: "a.root-servers.net (198.41.0.4)",
        ms: 18,
        outcome: "referral",
        detail: "com is served by a.gtld-servers.net",
      },
      {
        zone: "com",
        server: "a.gtld-servers.net (192.5.6.30)",
        ms: 21,
        outcome: "nxdomain",
        detail: "com says shop.example.com does not exist",
      },
    ],
  },
  notes: [],
  tookMs: 4_200,
};

async function register(name: string) {
  const creds = await ctx.container.modules
    .find((m): m is ProbesModule => m.name === "probes")
    ?.service.register({ name: `${name}-${run}`, region: "eu-west", kind: "managed" });
  if (creds === undefined) throw new Error("no probes module");
  const hello = await probeClient(ctx.app, creds).call("POST", "/hello", {
    version: "0.1.0",
    mode: "managed",
    region: "eu-west",
    capabilities: ["http"],
  });
  expect(hello.status, hello.text).toBe(200);
  return creds;
}

/* This monitor's diagnose task, as a probe that asks for that kind gets it. */
async function claim(as: ReturnType<typeof probeClient>, monitorId: string) {
  const res = await as.call("GET", "/tasks?wait=0&kinds=diagnose");
  expect(res.status, res.text).toBe(200);
  return (res.body.tasks as ProbeTask[]).find((task) => task.monitor.id === monitorId);
}

beforeAll(async () => {
  ctx = buildContainerApp({ authRateLimit: false });
  owner = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `diag-${run}@example.com`);
  const created = await owner
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "Diagnostics Co", slug: `diag-${run}` });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id as string;
  detection = ctx.container.modules.find((m) => m.name === "detection") as DetectionModule;
  const creds = await register("diag");
  const otherCreds = await register("diag-other");
  client = probeClient(ctx.app, creds);
  otherClient = probeClient(ctx.app, otherCreds);
  probe = { id: creds.id, region: "eu-west", kind: "managed", workspaceId: null };
  other = { id: otherCreds.id, region: "eu-west", kind: "managed", workspaceId: null };
}, 120_000);

afterAll(async () => {
  await ctx.container.infra.db.execute(sql`delete from probe_tasks where workspace_id = ${ws}`);
  await ctx.container.infra.db.execute(
    sql`delete from probes where id in (${probe.id}, ${other.id})`,
  );
  await ctx.container.close();
});

describe("network diagnostics", () => {
  let monitorId = "";
  let incidentId = "";
  let taskId = "";

  it("asks the failing region for a trace when an incident opens", async () => {
    monitorId = await createMonitor("Shop", { type: "http", url: "https://shop.example.com/" });
    incidentId = await outage(monitorId);
    expect(
      await rows(
        sql`select kind, region from probe_tasks where monitor_id = ${monitorId} and kind = 'diagnose'`,
      ),
    ).toEqual([{ kind: "diagnose", region: "eu-west" }]);
  });

  it("hands the task only to a probe that says it runs diagnostics", async () => {
    /* A probe from before this feature asks for tasks the old way and is not sent one. */
    const old = await client.call("GET", "/tasks?wait=0");
    expect(old.status, old.text).toBe(200);
    expect((old.body.tasks as ProbeTask[]).filter((t) => t.kind === "diagnose")).toEqual([]);

    const task = await claim(client, monitorId);
    expect(task).toMatchObject({ kind: "diagnose", monitor: { id: monitorId } });
    taskId = task?.id ?? "";
  });

  it("puts the report on the incident's timeline, once, and only from the probe asked", async () => {
    const stranger = await otherClient.call("POST", "/diagnostics", { taskId, diagnostics });
    expect(stranger.status, stranger.text).toBe(202);
    expect(stranger.body).toEqual({ recorded: false });

    const bad = await client.call("POST", "/diagnostics", { taskId, diagnostics: { host: 1 } });
    expect(bad.status).toBe(400);

    const sent = await client.call("POST", "/diagnostics", { taskId, diagnostics });
    expect(sent.status, sent.text).toBe(202);
    expect(sent.body).toEqual({ recorded: true });
    const again = await client.call("POST", "/diagnostics", { taskId, diagnostics });
    expect(again.body).toEqual({ recorded: false });

    const detail = await api("get", `/incidents/${incidentId}`);
    expect(detail.status, detail.text).toBe(200);
    const events = (
      detail.body.timeline as Array<{ type: string; data: Record<string, unknown> }>
    ).filter((event) => event.type === "network_diagnostics");
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toEqual({ region: "eu-west", ...diagnostics });
  });

  it("asks for nothing when the monitor reaches no host itself", async () => {
    const heartbeat = await createMonitor("Nightly job", {
      type: "heartbeat",
      schedule: { kind: "period", periodSeconds: 3_600 },
    });
    expect(await rows(sql`select 1 from probe_tasks where monitor_id = ${heartbeat}`)).toEqual([]);
  });

  it("asks for nothing when the server answered: the network was fine", async () => {
    const answered = await createMonitor("Answering", {
      type: "http",
      url: "https://answers.example.com/",
    });
    await ctx.container.infra.db.execute(
      sql`update probes set last_seen_at = now() where id = ${probe.id}`,
    );
    for (const secondsAgo of [20, 5]) {
      await detection.service.ingest(probe, {
        batchId: uuidv7(),
        results: [
          {
            ...refused(answered, secondsAgo),
            errorCode: "http_status_unexpected",
            httpStatus: 503,
            message: "HTTP 503 (expected 200-299)",
          },
        ],
      });
      await detection.service.evaluateMonitor(answered);
    }
    expect(
      await rows(
        sql`select 1 from incidents where monitor_id = ${answered} and resolved_at is null`,
      ),
    ).toHaveLength(1);
    expect(
      await rows(
        sql`select 1 from probe_tasks where monitor_id = ${answered} and kind = 'diagnose'`,
      ),
    ).toEqual([]);
  });

  it("traces a multi-step check to the host of its first step", async () => {
    const flow = await createMonitor("Login flow", {
      type: "multistep",
      steps: [
        { name: "Health", url: "https://api.example.com/health" },
        { name: "Other", url: "https://cdn.example.net/ping" },
      ],
    });
    await outage(flow);
    const task = await claim(client, flow);
    expect(task?.kind).toBe("diagnose");
    expect(task?.monitor.config).toMatchObject({ type: "multistep" });
  });
});
