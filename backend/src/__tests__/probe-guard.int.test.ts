/*
 * P2-T03, probe health guard (PRODUCT.md §9.2). Chaos mode "probe fails everything": a managed probe
 * that reports failures for all its monitors is quarantined before any of them is evaluated, so no
 * customer incident opens; ops get one notice. A real outage of some monitors still alerts as usual.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { v7 as uuidv7 } from "uuid";
import type { Region } from "@app/shared";
import type { AuthenticatedProbe } from "../middleware/probe-auth.js";
import type { DetectionModule } from "../modules/detection/index.js";
import type { ProbesModule } from "../modules/probes/index.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  probeClient,
  signUpVerified,
} from "./helpers/container-app.js";

const OPS_EMAIL = `ops-${randomBytes(4).toString("hex")}@example.com`;

let ctx: ReturnType<typeof buildContainerApp>;
let owner: TestAgent;
let ws: string;
let detection: DetectionModule;
let probes: ProbesModule;

const post = (path: string, body: object) => owner.post(path).set("Origin", WEB_ORIGIN).send(body);

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await ctx.container.infra.db.execute(query)).rows as T[];
}

type TestProbe = AuthenticatedProbe & { name: string };

async function managedProbe(region: Region): Promise<TestProbe> {
  const name = `guard-${region}-${randomBytes(3).toString("hex")}`;
  const creds = await probes.service.register({ name, region, kind: "managed" });
  const hello = await probeClient(ctx.app, creds).call("POST", "/hello", {
    version: "0.1.0",
    mode: "managed",
    region,
    capabilities: ["tcp"],
  });
  expect(hello.status, hello.text).toBe(200);
  return { id: creds.id, region, kind: "managed", workspaceId: null, name };
}

async function monitorsIn(region: Region, count: number, label: string): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const res = await post(`/api/w/${ws}/monitors`, {
      settings: { name: `${label} ${i}`, regions: [region], minFailingRegions: 1 },
      config: { type: "tcp", host: "example.com", port: 443 },
    });
    expect(res.status, res.text).toBe(201);
    ids.push(res.body.id as string);
  }
  return ids;
}

/*
 * A real probe keeps saying hello; these tests call the services directly, so they mark it as seen.
 * Without this its region would stop counting after a minute and hide what the guard does.
 */
const seenNow = (probe: AuthenticatedProbe) =>
  ctx.container.infra.db.execute(
    sql`update probes set last_seen_at = now() where id = ${probe.id}`,
  );

/* One batch of results from a probe, as it would post them. */
async function report(
  probe: AuthenticatedProbe,
  monitorIds: string[],
  secondsAgo: number,
  failing: (monitorId: string) => boolean,
) {
  await seenNow(probe);
  return detection.service.ingest(probe, {
    batchId: uuidv7(),
    results: monitorIds.map((monitorId) => {
      const ok = !failing(monitorId);
      return {
        id: uuidv7(),
        monitorId,
        region: probe.region,
        checkedAt: new Date(Date.now() - secondsAgo * 1_000).toISOString(),
        ok,
        latencyMs: 20,
        ...(ok ? {} : { errorCode: "connect_timeout" }),
      };
    }),
  });
}
const allOk = () => false;
const allFail = () => true;

async function evaluateAll(probe: AuthenticatedProbe, monitorIds: string[]) {
  await seenNow(probe);
  for (const id of monitorIds) await detection.service.evaluateMonitor(id);
}

async function incidentCount(monitorIds: string[]): Promise<number> {
  const found = await rows<{ monitor_id: string }>(
    sql`select monitor_id from incidents where workspace_id = ${ws}`,
  );
  const wanted = new Set(monitorIds);
  return found.filter((row) => wanted.has(row.monitor_id)).length;
}

/* Raw queries return timestamps as text. */
async function quarantinedUntil(probeId: string): Promise<Date | null> {
  const [row] = await rows<{ quarantined_until: string | null }>(
    sql`select quarantined_until from probes where id = ${probeId}`,
  );
  return row === undefined || row.quarantined_until === null
    ? null
    : new Date(row.quarantined_until);
}

/* Subjects of the ops notices queued about one probe (its ID is in every notice). */
async function opsNotices(probe: TestProbe): Promise<string[]> {
  const found = await rows<{ subject: string; body: string }>(
    sql`select payload->'data'->>'subject' as subject, (payload->'data')::text as body
        from outbox_events
        where type = 'email.requested' and payload->>'to' = ${OPS_EMAIL}
        order by created_at, id`,
  );
  return found.filter((row) => row.body.includes(probe.id)).map((row) => row.subject);
}

const reducedRegions = async () =>
  (await owner.get(`/api/w/${ws}/monitor-states`).set("Origin", WEB_ORIGIN)).body
    .reducedRegions as string[];

beforeAll(async () => {
  ctx = buildContainerApp({ authRateLimit: false, env: { OPS_EMAIL } });
  owner = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `guard-${randomBytes(4).toString("hex")}@example.com`);
  const created = await post("/api/auth/organization/create", {
    name: "Guard Co",
    slug: `guard-co-${randomBytes(4).toString("hex")}`,
  });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id;
  const find = <T>(name: string) => ctx.container.modules.find((m) => m.name === name) as T;
  detection = find<DetectionModule>("detection");
  probes = find<ProbesModule>("probes");
}, 120_000);

afterAll(async () => {
  await ctx.container.infra.db.execute(sql`delete from probe_tasks where workspace_id = ${ws}`);
  /* Leave no quarantined or extra probes behind for other test files sharing the database. */
  await ctx.container.infra.db.execute(sql`delete from probes where name like 'guard-%'`);
  await ctx.container.close();
});

describe("probe health guard", () => {
  it('chaos mode "probe fails everything" creates zero customer incidents', async () => {
    const probe = await managedProbe("sa-east");
    const monitorIds = await monitorsIn("sa-east", 60, "Chaos");
    await report(probe, monitorIds, 120, allOk);
    await evaluateAll(probe, monitorIds);
    expect(await reducedRegions()).not.toContain("sa-east");

    /* The probe's network breaks: every check fails, round after round. */
    await report(probe, monitorIds, 60, allFail);
    expect(await quarantinedUntil(probe.id)).not.toBeNull();
    await evaluateAll(probe, monitorIds);
    await report(probe, monitorIds, 30, allFail);
    await evaluateAll(probe, monitorIds);
    await report(probe, monitorIds, 0, allFail);
    await evaluateAll(probe, monitorIds);

    expect(await incidentCount(monitorIds)).toBe(0);
    const until = await quarantinedUntil(probe.id);
    expect(until !== null && until.getTime() > Date.now() + 8 * 60_000).toBe(true);

    /* Ops are told once, however many rounds fail; customers never are. */
    expect(await opsNotices(probe)).toEqual(["Probe in sa-east quarantined"]);
    /* The monitor page can say which regions aren't counting. */
    expect(await reducedRegions()).toContain("sa-east");
  }, 300_000);

  it("a real outage of some monitors alerts as usual, round after round", async () => {
    const probe = await managedProbe("us-west");
    const monitorIds = await monitorsIn("us-west", 60, "Mixed");
    const down = new Set(monitorIds.slice(0, 10));
    const tenDown = (id: string) => down.has(id);
    await report(probe, monitorIds, 120, allOk);
    await evaluateAll(probe, monitorIds);

    /* Ten of sixty really are down (17%). The same ten failing again must not add up to more. */
    for (const secondsAgo of [100, 80, 60]) {
      await report(probe, monitorIds, secondsAgo, tenDown);
      await evaluateAll(probe, [...down]);
    }
    expect(await quarantinedUntil(probe.id)).toBeNull();
    expect(await incidentCount([...down])).toBe(10);

    /* Then the probe itself starts to go: failures spread in batches too small to look broken. */
    await report(probe, monitorIds.slice(10, 15), 40, allFail);
    expect(await quarantinedUntil(probe.id)).toBeNull();
    await report(probe, monitorIds.slice(15, 20), 30, allFail);
    /* 20 of 60 is over 30%: quarantined before that batch is evaluated. */
    expect(await quarantinedUntil(probe.id)).not.toBeNull();
    await evaluateAll(probe, monitorIds.slice(10, 20));
    await report(probe, monitorIds.slice(10, 20), 20, allFail);
    await evaluateAll(probe, monitorIds.slice(10, 20));
    expect(await incidentCount(monitorIds.slice(10, 20))).toBe(0);

    /* The sweep keeps the quarantine going while the probe still fails this much. */
    await seenNow(probe);
    expect(await probes.service.guardSweep()).toContain(probe.id);
    expect(await opsNotices(probe)).toEqual(["Probe in us-west quarantined"]);
  }, 300_000);

  it("never quarantines a customer's private probe: their network may really be down", async () => {
    const creds = await probes.service.register({
      name: `guard-private-${randomBytes(3).toString("hex")}`,
      region: "me-central",
      kind: "private",
      workspaceId: ws,
    });
    const probe: AuthenticatedProbe = {
      id: creds.id,
      region: "me-central",
      kind: "private",
      workspaceId: ws,
    };
    expect(await probes.service.guard(probe, { monitors: 80, failing: 80 })).toBe(false);
    expect(await quarantinedUntil(probe.id)).toBeNull();
  });

  it("tells ops once when a probe stops reporting, and its region stops counting", async () => {
    const probe = await managedProbe("ap-south");
    expect(await reducedRegions()).not.toContain("ap-south");
    await ctx.container.infra.db.execute(
      sql`update probes set last_seen_at = now() - interval '5 minutes' where id = ${probe.id}`,
    );
    await probes.service.guardSweep();
    await probes.service.guardSweep();
    expect(await opsNotices(probe)).toEqual(["Probe in ap-south stopped reporting"]);
    expect(await reducedRegions()).toContain("ap-south");
  });
});
