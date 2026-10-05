/*
 * P2-T04 through the real API: a failed check's evidence is stored as a private bundle, the incident
 * keeps its key and the timing of the failure, the bundle is served only inside its workspace, and a
 * storage problem never costs a result.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { v7 as uuidv7 } from "uuid";
import type { CheckResult, IncidentEvidenceItem } from "@app/shared";
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
let stranger: TestAgent;
let ws: string;
let detection: DetectionModule;
let probe: AuthenticatedProbe;

const as = (agent: TestAgent) => ({
  post: (path: string, body: object) => agent.post(path).set("Origin", WEB_ORIGIN).send(body),
  get: (path: string) => agent.get(path).set("Origin", WEB_ORIGIN),
});

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await ctx.container.infra.db.execute(query)).rows as T[];
}

async function createMonitor(name: string): Promise<string> {
  const res = await as(owner).post(`/api/w/${ws}/monitors`, {
    settings: { name, regions: ["eu-west"], minFailingRegions: 1 },
    config: { type: "http", url: "https://shop.example.com/health" },
  });
  expect(res.status, res.text).toBe(201);
  return res.body.id as string;
}

/* A 502 from the customer's server, as the probe reports it. */
function badGateway(monitorId: string, secondsAgo: number): CheckResult {
  return {
    id: uuidv7(),
    monitorId,
    region: "eu-west",
    checkedAt: new Date(Date.now() - secondsAgo * 1_000).toISOString(),
    ok: false,
    errorCode: "http_status_unexpected",
    message: "HTTP 502 (expected 2xx)",
    httpStatus: 502,
    latencyMs: 412,
    timings: { dns: 4, connect: 12, tls: 16, ttfb: 370, download: 10, total: 412 },
    ip: "203.0.113.9",
    details: { finalUrl: "https://shop.example.com/health" },
    evidence: {
      headers: { "content-type": "text/html", server: "nginx", "cf-ray": "8a1b2c-FRA" },
      bodySnippet: "<h1>502 Bad Gateway</h1>",
      bodyBytes: 24,
      bodyTruncated: false,
    },
  };
}

async function report(results: CheckResult[]) {
  await ctx.container.infra.db.execute(
    sql`update probes set last_seen_at = now() where id = ${probe.id}`,
  );
  return detection.service.ingest(probe, { batchId: uuidv7(), results });
}

/* Two failures confirm a single-region outage: the incident opens on the second. */
async function outage(name: string) {
  const monitorId = await createMonitor(name);
  const first = badGateway(monitorId, 20);
  const second = badGateway(monitorId, 5);
  await report([first]);
  await detection.service.evaluateMonitor(monitorId);
  await report([second]);
  const outcome = await detection.service.evaluateMonitor(monitorId);
  expect(outcome?.decision.openIncident).toBe(true);
  return { monitorId, first, second, incidentId: outcome?.incidentId ?? "" };
}

beforeAll(async () => {
  ctx = buildContainerApp({ authRateLimit: false });
  owner = request.agent(ctx.app);
  stranger = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `evidence-${randomBytes(4).toString("hex")}@example.com`);
  const created = await as(owner).post("/api/auth/organization/create", {
    name: "Evidence Co",
    slug: `evidence-co-${randomBytes(4).toString("hex")}`,
  });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id;
  await signUpVerified(ctx, stranger, `stranger-${randomBytes(4).toString("hex")}@example.com`);
  await as(stranger).post("/api/auth/organization/create", {
    name: "Other Co",
    slug: `other-co-${randomBytes(4).toString("hex")}`,
  });

  const find = <T>(name: string) => ctx.container.modules.find((m) => m.name === name) as T;
  detection = find<DetectionModule>("detection");
  const creds = await find<ProbesModule>("probes").service.register({
    name: `evidence-${randomBytes(3).toString("hex")}`,
    region: "eu-west",
    kind: "managed",
  });
  const hello = await probeClient(ctx.app, creds).call("POST", "/hello", {
    version: "0.1.0",
    mode: "managed",
    region: "eu-west",
    capabilities: ["http"],
  });
  expect(hello.status, hello.text).toBe(200);
  probe = { id: creds.id, region: "eu-west", kind: "managed", workspaceId: null };
}, 120_000);

afterAll(async () => {
  await ctx.container.infra.db.execute(sql`delete from probe_tasks where workspace_id = ${ws}`);
  await ctx.container.infra.db.execute(sql`delete from probes where id = ${probe.id}`);
  await ctx.container.close();
});

describe("evidence bundles", () => {
  let incidentId: string;
  let key: string;

  it("stores a private bundle per failed result and keeps its key on the result", async () => {
    const { second, incidentId: id } = await outage("Shop health");
    incidentId = id;
    const [row] = await rows<{ evidence_key: string | null }>(
      sql`select evidence_key from check_results where id = ${second.id}`,
    );
    key = row?.evidence_key ?? "";
    expect(key).toBe(`evidence/${ws}/${second.checkedAt.slice(0, 10)}/${second.id}.json`);
    const stored = JSON.parse(ctx.objects.objects.get(key)?.toString("utf8") ?? "{}");
    expect(stored).toMatchObject({
      version: 1,
      resultId: second.id,
      region: "eu-west",
      httpStatus: 502,
      errorCode: "http_status_unexpected",
      headers: { server: "nginx", "cf-ray": "8a1b2c-FRA" },
      bodySnippet: "<h1>502 Bad Gateway</h1>",
      timings: { ttfb: 370, total: 412 },
    });
  });

  it("the incident says how long the failing check took and where the time went", async () => {
    const detail = await as(owner).get(`/api/w/${ws}/incidents/${incidentId}`);
    expect(detail.status, detail.text).toBe(200);
    expect(detail.body.timing).toBe(
      "Answered in 412 ms; slowest step: waiting for the first byte (370 ms)",
    );
    expect(detail.body.failingRegions).toEqual(["eu-west"]);
    expect(detail.body.causeCode).toBe("http_status_unexpected");
  });

  it("serves the bundle to the incident's workspace, per failing region", async () => {
    const res = await as(owner).get(`/api/w/${ws}/incidents/${incidentId}/evidence`);
    expect(res.status, res.text).toBe(200);
    const items = res.body.data as IncidentEvidenceItem[];
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ region: "eu-west", available: true });
    if (item?.available !== true) throw new Error("bundle not available");
    expect(item.bundle).toMatchObject({
      httpStatus: 502,
      message: "HTTP 502 (expected 2xx)",
      ip: "203.0.113.9",
      headers: { "content-type": "text/html", server: "nginx" },
      bodySnippet: "<h1>502 Bad Gateway</h1>",
      bodyTruncated: false,
    });
  });

  it("is invisible from another workspace, whichever workspace is put in the address", async () => {
    const other = (await as(stranger).get("/api/auth/organization/list")).body[0].id as string;
    /* Not a member: the workspace itself doesn't exist for them. */
    expect((await as(stranger).get(`/api/w/${ws}/incidents/${incidentId}/evidence`)).status).toBe(
      404,
    );
    expect(
      (await as(stranger).get(`/api/w/${other}/incidents/${incidentId}/evidence`)).status,
    ).toBe(404);
  });

  it("never follows a key that names another workspace", async () => {
    /* A row that somehow points at someone else's object must not be read. */
    const foreign = `evidence/${uuidv7()}/2026-10-05/${uuidv7()}.json`;
    await ctx.objects.put(foreign, JSON.stringify({ secret: true }));
    await ctx.container.infra.db.execute(sql`
      update incidents set evidence = jsonb_set(evidence, '{bundles,0,key}', to_jsonb(${foreign}::text))
      where id = ${incidentId}`);
    const res = await as(owner).get(`/api/w/${ws}/incidents/${incidentId}/evidence`);
    expect(res.body.data).toEqual([
      { region: "eu-west", checkedAt: expect.any(String), available: false },
    ]);
    await ctx.container.infra.db.execute(sql`
      update incidents set evidence = jsonb_set(evidence, '{bundles,0,key}', to_jsonb(${key}::text))
      where id = ${incidentId}`);
  });

  it("says the evidence is no longer available once the object is gone", async () => {
    await ctx.objects.delete(key);
    const res = await as(owner).get(`/api/w/${ws}/incidents/${incidentId}/evidence`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { region: "eu-west", checkedAt: expect.any(String), available: false },
    ]);
  });

  it("keeps the result and opens the incident when storage is down", async () => {
    const put = ctx.objects.put.bind(ctx.objects);
    ctx.objects.put = () => Promise.reject(new Error("storage is down"));
    try {
      const { second, incidentId: id } = await outage("Shop checkout");
      const [row] = await rows<{ evidence_key: string | null }>(
        sql`select evidence_key from check_results where id = ${second.id}`,
      );
      expect(row).toEqual({ evidence_key: null });
      const res = await as(owner).get(`/api/w/${ws}/incidents/${id}/evidence`);
      expect(res.body.data).toEqual([]);
      /* The timing comes from the result itself, so alerts still have it. */
      const detail = await as(owner).get(`/api/w/${ws}/incidents/${id}`);
      expect(detail.body.timing).toContain("Answered in 412 ms");
    } finally {
      ctx.objects.put = put;
    }
  });

  it("stores nothing for results that passed", async () => {
    const monitorId = await createMonitor("Shop home");
    const before = ctx.objects.objects.size;
    const ok: CheckResult = {
      id: uuidv7(),
      monitorId,
      region: "eu-west",
      checkedAt: new Date().toISOString(),
      ok: true,
      httpStatus: 200,
      latencyMs: 80,
    };
    await report([ok]);
    expect(ctx.objects.objects.size).toBe(before);
  });
});
