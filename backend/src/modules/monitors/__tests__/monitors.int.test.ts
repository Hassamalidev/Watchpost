/*
 * P1-T04 AC against real Postgres through the HTTP API: CRUD for every Phase 1 type, Free-plan limits,
 * cross-workspace denial, the change sequence on every write, secrets, roles, groups and tags.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { createDbPool, type DbPool } from "../../../infra/db/index.js";
import { outboxEvents } from "../../../infra/outbox/index.js";
import { createRedis, type RedisClient } from "../../../infra/redis.js";
import { TEST_DATABASE_URL, TEST_REDIS_URL } from "../../../__tests__/helpers/test-env.js";
import {
  WEB_ORIGIN,
  buildWorkspaceTestApp,
  createWorkspace,
  get,
  inviteAndAccept,
  patch,
  post,
  signUpAndVerify,
  uniqueEmail,
  type CapturedEmail,
} from "../../../__tests__/helpers/workspace-app.js";
import { MASKED } from "../index.js";
import { createMonitorsRepository } from "../monitors.repository.js";
import { monitors as monitorsTable } from "../schema/monitors.js";

let pool: DbPool;
let redis: RedisClient;
const emails: CapturedEmail[] = [];
let ctx: ReturnType<typeof buildWorkspaceTestApp>;
let owner: TestAgent;
let viewer: TestAgent;
let stranger: TestAgent;
let ws: string;
let strangerWs: string;

const del = (agent: TestAgent, path: string) => agent.delete(path).set("Origin", WEB_ORIGIN);

async function createMonitor(
  agent: TestAgent,
  workspaceId: string,
  settings: Record<string, unknown>,
  config: Record<string, unknown>,
) {
  return post(agent, `/api/w/${workspaceId}/monitors`, { settings, config });
}

beforeAll(async () => {
  pool = createDbPool(TEST_DATABASE_URL, { max: 10 });
  redis = createRedis(TEST_REDIS_URL);
  ctx = buildWorkspaceTestApp({ pool, redis, emails });
  owner = request.agent(ctx.app);
  viewer = request.agent(ctx.app);
  stranger = request.agent(ctx.app);

  await signUpAndVerify(owner, emails, uniqueEmail("mon-owner"), "Owner");
  ws = await createWorkspace(owner, "Monitors Co");
  const viewerEmail = uniqueEmail("mon-viewer");
  await signUpAndVerify(viewer, emails, viewerEmail, "Viewer");
  await inviteAndAccept(owner, viewer, emails, ws, viewerEmail, "viewer");
  await signUpAndVerify(stranger, emails, uniqueEmail("mon-stranger"), "Stranger");
  strangerWs = await createWorkspace(stranger, "Other Co");
});

afterAll(async () => {
  await pool.end();
  await redis.quit();
});

describe("CRUD", () => {
  const configs: Array<Record<string, unknown>> = [
    { type: "http", url: "https://example.com/health" },
    { type: "keyword", url: "https://example.com", keyword: "Welcome" },
    {
      type: "json_query",
      url: "https://example.com/api",
      expression: "status",
      operator: "==",
      expected: "ok",
    },
    { type: "tcp", host: "db.example.com", port: 5432 },
    { type: "ping", host: "203.0.113.10" },
    { type: "dns", hostname: "example.com", recordType: "A" },
    { type: "websocket", url: "wss://example.com/socket" },
    { type: "ssl", host: "example.com" },
    { type: "domain", domain: "example.com" },
    { type: "heartbeat", schedule: { kind: "period", periodSeconds: 3600 } },
  ];

  it("creates a monitor of every Phase 1 type with defaults applied", async () => {
    for (const config of configs) {
      const res = await createMonitor(
        owner,
        ws,
        { name: `${String(config.type)} check`, tags: ["prod"] },
        config,
      );
      expect(res.status, `${String(config.type)}: ${res.text}`).toBe(201);
      expect(res.body).toMatchObject({
        type: config.type,
        intervalSeconds: 300,
        regions: ["eu-central", "us-east"],
        minFailingRegions: 2,
        paused: false,
        tags: ["prod"],
      });
    }
  });

  it("lists with filters and cursor pagination", async () => {
    const first = await get(owner, `/api/w/${ws}/monitors?limit=4`);
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(4);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await get(
      owner,
      `/api/w/${ws}/monitors?limit=100&cursor=${first.body.nextCursor}`,
    );
    expect(second.body.data).toHaveLength(6);
    expect(second.body.nextCursor).toBeNull();

    expect((await get(owner, `/api/w/${ws}/monitors?type=tcp`)).body.data).toHaveLength(1);
    expect((await get(owner, `/api/w/${ws}/monitors?tag=prod`)).body.data).toHaveLength(10);
    expect((await get(owner, `/api/w/${ws}/monitors?q=keyword`)).body.data[0].type).toBe("keyword");
    expect((await get(owner, `/api/w/${ws}/monitors?type=grpc`)).status).toBe(400);
  });

  it("updates settings and config, keeps the type fixed, and validates the merged result", async () => {
    const created = await createMonitor(
      owner,
      ws,
      { name: "Update me" },
      { type: "tcp", host: "a.example.com", port: 80 },
    );
    const id = created.body.id as string;

    const updated = await patch(owner, `/api/w/${ws}/monitors/${id}`, {
      settings: { name: "Renamed", intervalSeconds: 600, tags: ["edge", "prod"] },
      config: { type: "tcp", host: "b.example.com", port: 443, tls: true },
    });
    expect(updated.status, updated.text).toBe(200);
    expect(updated.body).toMatchObject({
      name: "Renamed",
      intervalSeconds: 600,
      tags: ["edge", "prod"],
    });
    expect(updated.body.config).toMatchObject({ host: "b.example.com", port: 443, tls: true });

    const typeChange = await patch(owner, `/api/w/${ws}/monitors/${id}`, {
      config: { type: "http", url: "https://x.example.com" },
    });
    expect(typeChange.status).toBe(400);

    /* Invalid input is rejected before plan limits are considered. */
    const timeoutOverInterval = await patch(owner, `/api/w/${ws}/monitors/${id}`, {
      settings: { timeoutMs: 30_000, intervalSeconds: 20 },
    });
    expect(timeoutOverInterval.status).toBe(400);
    expect(JSON.parse(timeoutOverInterval.text).errors[0].path).toBe("settings.timeoutMs");
    /* Valid but faster than the Free plan allows. */
    const tooFast = await patch(owner, `/api/w/${ws}/monitors/${id}`, {
      settings: { intervalSeconds: 60 },
    });
    expect(tooFast.status).toBe(402);
    const ok = await patch(owner, `/api/w/${ws}/monitors/${id}`, {
      settings: { intervalSeconds: 180, timeoutMs: 30_000 },
    });
    expect(ok.status).toBe(200);

    expect((await del(owner, `/api/w/${ws}/monitors/${id}`)).status).toBe(204);
    expect((await get(owner, `/api/w/${ws}/monitors/${id}`)).status).toBe(404);
  });

  it("emits monitor.created, monitor.updated and monitor.deleted through the outbox", async () => {
    const types = (
      await ctx.db
        .select({ type: outboxEvents.type })
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.workspaceId, ws),
            inArray(outboxEvents.type, ["monitor.created", "monitor.updated", "monitor.deleted"]),
          ),
        )
    ).map((r) => r.type);
    expect(types).toContain("monitor.created");
    expect(types).toContain("monitor.updated");
    expect(types).toContain("monitor.deleted");
  });
});

describe("change sequence (probe sync feed)", () => {
  it("bumps the sequence on every change, and the feed reports upserts then the delete", async () => {
    const before = await ctx.monitors.service.latestSeq();
    const created = await createMonitor(
      owner,
      ws,
      { name: "Seq" },
      { type: "ping", host: "198.51.100.7" },
    );
    const id = created.body.id as string;
    const seqs = [created.body];

    await patch(owner, `/api/w/${ws}/monitors/${id}`, { settings: { name: "Seq 2" } });
    seqs.push((await get(owner, `/api/w/${ws}/monitors/${id}`)).body);
    await post(owner, `/api/w/${ws}/monitors/${id}/pause`, {});
    await post(owner, `/api/w/${ws}/monitors/${id}/resume`, {});

    const [row] = await ctx.db.select().from(monitorsTable).where(eq(monitorsTable.id, id));
    expect(row?.configSeq).toBeGreaterThan(before);

    const feed = await ctx.monitors.service.changesSince(before, 100);
    expect(feed.cursor).toBeGreaterThan(before);
    expect(feed.upserts.find((m) => m.id === id)?.configSeq).toBe(row?.configSeq);

    await del(owner, `/api/w/${ws}/monitors/${id}`);
    const afterDelete = await ctx.monitors.service.changesSince(feed.cursor, 100);
    expect(afterDelete.deletes).toContain(id);
    expect(afterDelete.upserts.map((m) => m.id)).not.toContain(id);
    expect(afterDelete.cursor).toBeGreaterThan(feed.cursor);
  });
});

describe("secrets", () => {
  it("never returns or stores credentials in plain text, and keeps them when the mask comes back", async () => {
    const created = await createMonitor(
      owner,
      ws,
      { name: "Secret API" },
      {
        type: "http",
        url: "https://api.example.com/health",
        auth: { kind: "basic", username: "ops", password: "hunter2-pass" },
        headers: [{ name: "X-Api-Key", value: "key-abc-123" }],
      },
    );
    expect(created.status, created.text).toBe(201);
    expect(created.text).not.toContain("hunter2-pass");
    expect(created.text).not.toContain("key-abc-123");
    expect(created.body.config.auth.password).toBe(MASKED);
    const id = created.body.id as string;

    const [row] = await ctx.db.select().from(monitorsTable).where(eq(monitorsTable.id, id));
    expect(JSON.stringify(row)).not.toContain("hunter2-pass");
    expect(row?.secretsEnc?.startsWith("v1.test.")).toBe(true);

    /* Round-trip the masked config (as a form would), changing only the URL. */
    const roundTrip = await patch(owner, `/api/w/${ws}/monitors/${id}`, {
      config: { ...created.body.config, url: "https://api.example.com/v2/health" },
    });
    expect(roundTrip.status, roundTrip.text).toBe(200);
    const feed = await ctx.monitors.service.changesSince(0, 10_000);
    const forProbe = feed.upserts.find((m) => m.id === id);
    expect(forProbe?.config).toMatchObject({
      url: "https://api.example.com/v2/health",
      auth: { kind: "basic", username: "ops", password: "hunter2-pass" },
      headers: [{ name: "X-Api-Key", value: "key-abc-123" }],
    });

    /* Masked secrets don't follow the monitor to another host. */
    const retarget = await patch(owner, `/api/w/${ws}/monitors/${id}`, {
      config: { ...created.body.config, url: "https://attacker.example.net/collect" },
    });
    expect(retarget.status).toBe(400);
    expect(retarget.text).toContain("target changed");
    const fresh = await patch(owner, `/api/w/${ws}/monitors/${id}`, {
      config: {
        ...created.body.config,
        url: "https://status.example.net/health",
        auth: { kind: "basic", username: "ops", password: "new-pass-456" },
        headers: [{ name: "X-Api-Key", value: "key-new-456" }],
      },
    });
    expect(fresh.status, fresh.text).toBe(200);
  });
});

describe("change feed", () => {
  it("hands out seqs in commit order, so a probe cursor never skips a slow transaction", async () => {
    const repo = createMonitorsRepository(ctx.db);
    const change = { monitorId: randomUUID(), workspaceId: ws, op: "upsert" as const };
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let firstSeq = 0;
    const first = ctx.db.transaction(async (tx) => {
      firstSeq = await repo.appendChange(tx, change);
      await held;
    });
    await new Promise((r) => setTimeout(r, 50));
    let secondDone = false;
    const second = ctx.db
      .transaction((tx) => repo.appendChange(tx, change))
      .then((seq) => {
        secondDone = true;
        return seq;
      });
    await new Promise((r) => setTimeout(r, 200));
    expect(secondDone).toBe(false);
    release();
    await first;
    expect(await second).toBeGreaterThan(firstSeq);
  });
});

describe("probe views", () => {
  it("skip a monitor whose secrets can't be decrypted instead of failing the whole list", async () => {
    const before = await createMonitor(
      owner,
      ws,
      { name: "Before" },
      { type: "tcp", host: "b.example.com", port: 443 },
    );
    const broken = await createMonitor(
      owner,
      ws,
      { name: "Broken secret" },
      {
        type: "http",
        url: "https://api.example.com/health",
        auth: { kind: "bearer", token: "abc" },
      },
    );
    const ok = await createMonitor(
      owner,
      ws,
      { name: "Fine" },
      { type: "tcp", host: "a.example.com", port: 443 },
    );
    await ctx.db
      .update(monitorsTable)
      .set({ secretsEnc: "v1.retired.AAAA.AAAA.AAAA" })
      .where(eq(monitorsTable.id, broken.body.id));

    const views = await ctx.monitors.service.getForProbes([broken.body.id, ok.body.id]);
    expect(views.map((v) => v.id)).toEqual([ok.body.id]);

    /* A page holding only the broken monitor is empty but not the last page. */
    const page = await ctx.monitors.service.listForProbes({ afterId: before.body.id, limit: 1 });
    expect(page).toEqual({ monitors: [], nextAfterId: broken.body.id });
    const next = await ctx.monitors.service.listForProbes({ afterId: broken.body.id, limit: 1 });
    expect(next.monitors.map((m) => m.id)).toEqual([ok.body.id]);
  });
});

describe("Free plan limits", () => {
  let limitsWs: string;

  beforeAll(async () => {
    limitsWs = await createWorkspace(owner, "Limits Co");
  });

  it("rejects intervals under 3 minutes and more than 2 regions with 402", async () => {
    const fast = await createMonitor(
      owner,
      limitsWs,
      { name: "Fast", intervalSeconds: 60 },
      { type: "tcp", host: "a.example.com", port: 80 },
    );
    expect(fast.status).toBe(402);
    expect(JSON.parse(fast.text).code).toBe("quota_exceeded");
    const wide = await createMonitor(
      owner,
      limitsWs,
      { name: "Wide", regions: ["eu-central", "us-east", "ap-southeast"] },
      { type: "tcp", host: "a.example.com", port: 80 },
    );
    expect(wide.status).toBe(402);
  });

  it("allows 20 monitors and 5 heartbeats, counts paused ones as free, and re-checks on resume", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const res = await createMonitor(
        owner,
        limitsWs,
        { name: `m${i}` },
        { type: "tcp", host: "a.example.com", port: 80 },
      );
      expect(res.status, res.text).toBe(201);
      ids.push(res.body.id);
    }
    const twentyFirst = await createMonitor(
      owner,
      limitsWs,
      { name: "m20" },
      { type: "tcp", host: "a.example.com", port: 80 },
    );
    expect(twentyFirst.status).toBe(402);

    for (let i = 0; i < 5; i += 1) {
      const hb = await createMonitor(
        owner,
        limitsWs,
        { name: `hb${i}` },
        { type: "heartbeat", schedule: { kind: "period", periodSeconds: 600 } },
      );
      expect(hb.status, hb.text).toBe(201);
    }
    const sixthHeartbeat = await createMonitor(
      owner,
      limitsWs,
      { name: "hb5" },
      { type: "heartbeat", schedule: { kind: "period", periodSeconds: 600 } },
    );
    expect(sixthHeartbeat.status).toBe(402);

    expect((await post(owner, `/api/w/${limitsWs}/monitors/${ids[0]}/pause`, {})).status).toBe(200);
    const replacement = await createMonitor(
      owner,
      limitsWs,
      { name: "replacement" },
      { type: "tcp", host: "a.example.com", port: 80 },
    );
    expect(replacement.status).toBe(201);
    expect((await post(owner, `/api/w/${limitsWs}/monitors/${ids[0]}/resume`, {})).status).toBe(
      402,
    );
  });

  it("holds the limit under concurrent creates", async () => {
    const raceWs = await createWorkspace(owner, "Race Co");
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        createMonitor(
          owner,
          raceWs,
          { name: `r${i}` },
          { type: "tcp", host: "a.example.com", port: 80 },
        ),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(20);
    expect(results.filter((r) => r.status === 402)).toHaveLength(5);
  });
});

describe("tenancy and roles", () => {
  let monitorId: string;

  beforeAll(async () => {
    monitorId = (
      await createMonitor(
        owner,
        ws,
        { name: "Private" },
        { type: "tcp", host: "a.example.com", port: 22 },
      )
    ).body.id;
  });

  it("hides a workspace's monitors from other workspaces", async () => {
    expect((await get(stranger, `/api/w/${ws}/monitors/${monitorId}`)).status).toBe(404);
    expect((await get(stranger, `/api/w/${strangerWs}/monitors/${monitorId}`)).status).toBe(404);
    expect(
      (
        await patch(stranger, `/api/w/${strangerWs}/monitors/${monitorId}`, {
          settings: { name: "x" },
        })
      ).status,
    ).toBe(404);
    expect((await del(stranger, `/api/w/${strangerWs}/monitors/${monitorId}`)).status).toBe(404);
    const crossParent = await createMonitor(
      stranger,
      strangerWs,
      { name: "Child", parentId: monitorId },
      { type: "tcp", host: "a.example.com", port: 80 },
    );
    expect(crossParent.status).toBe(400);
    expect((await get(owner, `/api/w/${ws}/monitors/${monitorId}`)).status).toBe(200);
  });

  it("lets viewers read but not change monitors", async () => {
    expect((await get(viewer, `/api/w/${ws}/monitors`)).status).toBe(200);
    expect((await get(viewer, `/api/w/${ws}/monitors/${monitorId}`)).status).toBe(200);
    expect(
      (
        await createMonitor(
          viewer,
          ws,
          { name: "Nope" },
          { type: "tcp", host: "a.example.com", port: 80 },
        )
      ).status,
    ).toBe(403);
    expect((await post(viewer, `/api/w/${ws}/monitors/${monitorId}/pause`, {})).status).toBe(403);
    expect((await del(viewer, `/api/w/${ws}/monitors/${monitorId}`)).status).toBe(403);
  });
});

describe("groups, tags and dependencies", () => {
  it("manages groups and filters by them", async () => {
    const group = await post(owner, `/api/w/${ws}/monitor-groups`, { name: "Production" });
    expect(group.status).toBe(201);
    expect((await post(owner, `/api/w/${ws}/monitor-groups`, { name: "Production" })).status).toBe(
      409,
    );

    const m = await createMonitor(
      owner,
      ws,
      { name: "Grouped", groupId: group.body.id },
      { type: "tcp", host: "a.example.com", port: 80 },
    );
    expect(m.status).toBe(201);
    expect(
      (await get(owner, `/api/w/${ws}/monitors?groupId=${group.body.id}`)).body.data,
    ).toHaveLength(1);

    expect(
      (await patch(owner, `/api/w/${ws}/monitor-groups/${group.body.id}`, { name: "Prod" })).body
        .name,
    ).toBe("Prod");
    expect((await del(owner, `/api/w/${ws}/monitor-groups/${group.body.id}`)).status).toBe(204);
    expect((await get(owner, `/api/w/${ws}/monitors/${m.body.id}`)).body.groupId).toBeNull();
  });

  it("lists tags used in the workspace", async () => {
    const tags = (await get(owner, `/api/w/${ws}/tags`)).body.data.map(
      (t: { name: string }) => t.name,
    );
    expect(tags).toEqual(expect.arrayContaining(["edge", "prod"]));
  });

  it("rejects dependency loops", async () => {
    const a = (
      await createMonitor(
        owner,
        ws,
        { name: "A" },
        { type: "tcp", host: "a.example.com", port: 80 },
      )
    ).body.id;
    const b = (
      await createMonitor(
        owner,
        ws,
        { name: "B", parentId: a },
        { type: "tcp", host: "b.example.com", port: 80 },
      )
    ).body.id;
    const c = (
      await createMonitor(
        owner,
        ws,
        { name: "C", parentId: b },
        { type: "tcp", host: "c.example.com", port: 80 },
      )
    ).body.id;
    expect(
      (await patch(owner, `/api/w/${ws}/monitors/${a}`, { settings: { parentId: c } })).status,
    ).toBe(409);
    expect(
      (await patch(owner, `/api/w/${ws}/monitors/${a}`, { settings: { parentId: a } })).status,
    ).toBe(400);
  });
});
