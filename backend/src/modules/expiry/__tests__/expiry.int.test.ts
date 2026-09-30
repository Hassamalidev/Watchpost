/*
 * P1-T15 AC with the real database, a fake clock and mocked RDAP: each threshold fires once, the
 * first opens a low-severity incident and later ones update it, a renewal resolves it, an early
 * certificate swap is recorded, expiry warnings never block an outage incident, and TLDs without
 * RDAP show a clear unsupported state.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { v7 as uuidv7 } from "uuid";
import { createFakeClock } from "../../../core/clock.js";
import { createWorkspaceScope, type WorkspaceScope } from "../../../core/workspace-scope.js";
import { newId } from "../../../infra/ids.js";
import type { IncidentsModule } from "../../incidents/index.js";
import type { MonitorsModule } from "../../monitors/index.js";
import type { ResultsModule } from "../../results/index.js";
import { createExpiryRepository } from "../expiry.repository.js";
import { createExpiryService, type ExpiryService } from "../expiry.service.js";
import { RDAP_BOOTSTRAP_URL } from "../rdap.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  signUpVerified,
  stubHttp,
} from "../../../__tests__/helpers/container-app.js";

const DAY = 86_400_000;
const clock = createFakeClock();
const domainExpiry = new Map<string, Date>();
const http = stubHttp((req) => {
  if (req.url === RDAP_BOOTSTRAP_URL) {
    return {
      body: JSON.stringify({ services: [[["com", "net"], ["https://rdap.registry.test/"]]] }),
    };
  }
  const name = req.url.match(/^https:\/\/rdap\.registry\.test\/domain\/(.+)$/)?.[1];
  const expires = name === undefined ? undefined : domainExpiry.get(name);
  if (expires === undefined) return { status: 404, body: "" };
  return {
    body: JSON.stringify({
      events: [{ eventAction: "expiration", eventDate: expires.toISOString() }],
      entities: [
        { roles: ["registrar"], vcardArray: ["vcard", [["fn", {}, "text", "Test Registrar"]]] },
      ],
    }),
  };
});

let ctx: ReturnType<typeof buildContainerApp>;
let owner: TestAgent;
let ws: string;
let scope: WorkspaceScope;
let service: ExpiryService;
let results: ResultsModule;

const post = (path: string, body: object = {}) =>
  owner.post(path).set("Origin", WEB_ORIGIN).send(body);
const get = (path: string) => owner.get(path).set("Origin", WEB_ORIGIN);
const db = () => ctx.container.infra.db;
const rows = async <T>(query: ReturnType<typeof sql>) => (await db().execute(query)).rows as T[];

async function monitor(name: string, config: object) {
  const res = await post(`/api/w/${ws}/monitors`, { settings: { name }, config });
  expect(res.status, res.text).toBe(201);
  return res.body.id as string;
}

/* A TLS result from a probe; the certificate is identified by its fingerprint. */
async function certificate(monitorId: string, fingerprint: string, validTo: Date) {
  await results.service.ingest([
    {
      id: uuidv7(),
      monitorId,
      workspaceId: ws,
      region: "eu-central",
      checkedAt: new Date().toISOString(),
      ok: true,
      latencyMs: 30,
      tls: {
        validFrom: new Date(validTo.getTime() - 90 * DAY).toISOString(),
        validTo: validTo.toISOString(),
        issuer: "CN=Test CA",
        subject: "CN=example.com",
        fingerprint256: fingerprint,
        daysRemaining: 0,
      },
    },
  ]);
}

const expiryIncidents = (monitorId: string) =>
  rows<{ id: string; status: string; title: string; severity: string; source: string }>(
    sql`select id, status, title, severity, source from incidents where monitor_id = ${monitorId} and source = 'expiry' order by started_at`,
  );
const noticeThresholds = (monitorId: string) =>
  rows<{ threshold: number }>(
    sql`select threshold from expiry_notices where monitor_id = ${monitorId} order by threshold desc`,
  ).then((r) => r.map((n) => n.threshold));

beforeAll(async () => {
  ctx = buildContainerApp({ http });
  owner = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `exp-owner-${randomBytes(4).toString("hex")}@example.com`);
  const created = await post("/api/auth/organization/create", {
    name: "Expiry Co",
    slug: `expiry-co-${randomBytes(4).toString("hex")}`,
  });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id;
  scope = createWorkspaceScope({ workspaceId: ws, role: "owner" });

  const find = <T>(name: string) => ctx.container.modules.find((m) => m.name === name) as T;
  results = find<ResultsModule>("results");
  service = createExpiryService({
    db: db(),
    repository: createExpiryRepository(),
    monitors: find<MonitorsModule>("monitors").service,
    results: results.service,
    incidents: find<IncidentsModule>("incidents").service,
    http,
    clock,
    logger: ctx.container.infra.logger,
    newId,
  });
});

afterAll(async () => {
  await ctx.container.close();
});

describe("SSL certificates", () => {
  let monitorId: string;
  const base = Date.now();
  const validTo = new Date(base + 40 * DAY + 3_600_000);

  it("stays quiet while every threshold is ahead", async () => {
    monitorId = await monitor("Cert", { type: "ssl", host: "example.com" });
    await certificate(monitorId, "AA:01", validTo);
    clock.set(new Date(base));
    await service.sweep();
    expect(await expiryIncidents(monitorId)).toEqual([]);
    expect(await service.get(scope, monitorId)).toMatchObject({
      kind: "ssl",
      status: "ok",
      daysRemaining: 40,
      details: { issuer: "CN=Test CA" },
    });
  });

  it("opens one low-severity incident at the first threshold, once", async () => {
    clock.set(new Date(base + 11 * DAY));
    await service.sweep();
    await service.sweep();
    const incidents = await expiryIncidents(monitorId);
    expect(incidents).toEqual([
      expect.objectContaining({
        status: "triggered",
        severity: "low",
        source: "expiry",
        title: "SSL certificate for example.com expires in 29 days",
      }),
    ]);
    expect(await noticeThresholds(monitorId)).toEqual([30]);
    expect((await service.get(scope, monitorId)).status).toBe("warning");
  });

  it("updates the same incident at the next threshold and tells people", async () => {
    clock.set(new Date(base + 27 * DAY));
    await service.sweep();
    const [incident] = await expiryIncidents(monitorId);
    expect(incident?.title).toBe("SSL certificate for example.com expires in 13 days");
    expect(await expiryIncidents(monitorId)).toHaveLength(1);
    expect(await noticeThresholds(monitorId)).toEqual([30, 14]);
    const updates = await rows<{ type: string }>(
      sql`select type from outbox_events where type = 'incident.updated' and payload->>'incidentId' = ${incident?.id}`,
    );
    expect(updates).toHaveLength(1);
  });

  it("never takes the monitor's slot for outage incidents", async () => {
    const incidents = ctx.container.modules.find((m) => m.name === "incidents") as IncidentsModule;
    const outage = await db().transaction((tx) =>
      incidents.service.openForMonitor(tx, {
        workspaceId: ws,
        monitorId,
        title: "Cert is down",
        severity: "high",
        causeCode: "connect_refused",
        failingRegions: ["eu-central"],
      }),
    );
    expect(outage.created).toBe(true);
    expect(outage.incident.source).toBe("monitor");
  });

  it("a renewal resolves the warning without an unexpected-change event", async () => {
    await certificate(monitorId, "BB:02", new Date(base + 120 * DAY));
    await service.sweep();
    expect((await expiryIncidents(monitorId)).map((i) => i.status)).toEqual(["resolved"]);
    expect((await service.get(scope, monitorId)).status).toBe("ok");
    const info = await rows<{ kind: string }>(
      sql`select kind from check_events where monitor_id = ${monitorId} and kind = 'info'`,
    );
    expect(info).toEqual([]);
  });

  it("records a certificate swapped long before it was due", async () => {
    await certificate(monitorId, "CC:03", new Date(base + 300 * DAY));
    await service.sweep();
    const info = await rows<{ message: string }>(
      sql`select message from check_events where monitor_id = ${monitorId} and kind = 'info'`,
    );
    expect(info).toHaveLength(1);
    expect(info[0]?.message).toMatch(/^The certificate for example\.com changed \d+ days before/);
  });

  it("a certificate first seen close to expiry warns once for the most urgent threshold", async () => {
    const https = await monitor("HTTPS site", {
      type: "http",
      url: "https://shop.example.com/health",
    });
    await certificate(https, "DD:04", new Date(Date.now() + 5 * DAY + 3_600_000));
    clock.set(new Date());
    await service.sweep();
    expect((await expiryIncidents(https)).map((i) => i.title)).toEqual([
      "SSL certificate for shop.example.com expires in 5 days",
    ]);
    expect(await noticeThresholds(https)).toEqual([30, 14, 7]);
  });
});

describe("domains", () => {
  it("looks registration expiry up once per domain and warns at 60 days", async () => {
    /* The lookup cache is shared across workspaces and test runs: use a fresh name. */
    const domain = `acme-${randomBytes(4).toString("hex")}.com`;
    const monitorId = await monitor("Domain", { type: "domain", domain });
    clock.set(new Date());
    domainExpiry.set(domain, new Date(Date.now() + 45 * DAY + 3_600_000));
    const first = await service.sweep();
    expect(first.lookups).toBeGreaterThanOrEqual(1);
    expect((await expiryIncidents(monitorId)).map((i) => i.title)).toEqual([
      `Domain ${domain} expires in 45 days`,
    ]);
    expect(await service.get(scope, monitorId)).toMatchObject({
      kind: "domain",
      status: "warning",
      daysRemaining: 45,
      details: { registrar: "Test Registrar", source: "rdap" },
    });

    const lookupsBefore = http.requests.filter((r) => r.url.includes(`/domain/${domain}`)).length;
    await service.sweep();
    const lookupsAfter = http.requests.filter((r) => r.url.includes(`/domain/${domain}`)).length;
    expect(lookupsAfter).toBe(lookupsBefore);
    expect(await expiryIncidents(monitorId)).toHaveLength(1);
  });

  it("shows a clear state for TLDs without RDAP and for unregistered names", async () => {
    const zz = await monitor("ZZ domain", { type: "domain", domain: "shop.zz" });
    const view = await post(`/api/w/${ws}/expiry/${zz}/check`);
    expect(view.status, view.text).toBe(200);
    expect(view.body).toMatchObject({
      status: "unsupported",
      message: "Domain expiry isn't available for .zz domains: the registry has no RDAP service.",
    });

    const missing = await monitor("Missing domain", { type: "domain", domain: "nobody-here.com" });
    const checked = await post(`/api/w/${ws}/expiry/${missing}/check`);
    expect(checked.body).toMatchObject({ status: "error" });
    expect(checked.body.message).toContain("registrable domain");
    expect((await get(`/api/w/${ws}/expiry/${zz}`)).body.status).toBe("unsupported");
  });

  it("refuses monitors with nothing to track", async () => {
    const plain = await monitor("Plain HTTP", { type: "http", url: "http://example.com/" });
    expect((await get(`/api/w/${ws}/expiry/${plain}`)).status).toBe(400);
  });
});
