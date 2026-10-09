/*
 * P7-T05a through the real app: a workspace's data comes out as one JSON file, and an owner can
 * have the workspace deleted. Deletion waits 30 days, in which it can be cancelled; then every row
 * that carries the workspace's ID is gone, and so is the stored evidence of its failed checks.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { v7 as uuidv7 } from "uuid";
import type { WorkspaceDeletionView, WorkspaceExport } from "@app/shared";
import { createFakeClock } from "../core/clock.js";
import { newId } from "../infra/ids.js";
import type { PrivacyModule } from "../modules/privacy/index.js";
import type { ResultsModule } from "../modules/results/index.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  emailFromOutbox,
  signUpVerified,
} from "./helpers/container-app.js";

const DAY = 86_400_000;
const clock = createFakeClock(new Date());
const ctx = buildContainerApp({
  authRateLimit: false,
  revalidate: async () => undefined,
  clock,
});
const run = randomBytes(4).toString("hex");
const ownerEmail = `privacy-${run}@example.com`;
const adminEmail = `privacy-admin-${run}@example.com`;
let owner: TestAgent;
let admin: TestAgent;
let ws = "";
let other = "";
let monitorId = "";

const find = <T>(name: string) => ctx.container.modules.find((m) => m.name === name) as T;
const privacy = () => find<PrivacyModule>("privacy").service;
const api = (agent: TestAgent, method: "get" | "post" | "delete", path: string, in_ = ws) =>
  agent[method](`/api/w/${in_}${path}`).set("Origin", WEB_ORIGIN);
const auth = (agent: TestAgent, path: string, body: object) =>
  agent.post(`/api/auth/${path}`).set("Origin", WEB_ORIGIN).send(body);

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await ctx.container.infra.db.execute(query)).rows as T[];
}

/* Every table that carries a workspace ID, and how many rows of this workspace it holds. */
async function rowsLeft(workspaceId: string): Promise<Record<string, number>> {
  const tables = await rows<{ table_name: string }>(sql`
    select c.table_name from information_schema.columns c
    join information_schema.tables t on t.table_name = c.table_name and t.table_schema = c.table_schema
    where c.table_schema = 'public' and c.column_name = 'workspace_id' and t.table_type = 'BASE TABLE'
      and c.table_name !~ '^check_results_p'`);
  const left: Record<string, number> = {};
  for (const { table_name: table } of tables) {
    const [{ n } = { n: 0 }] = await rows<{ n: number }>(
      sql`select count(*)::int as n from ${sql.identifier(table)} where workspace_id::text = ${workspaceId}`,
    );
    if (n > 0) left[table] = n;
  }
  return left;
}

beforeAll(async () => {
  owner = request.agent(ctx.app);
  admin = request.agent(ctx.app);
  await signUpVerified(ctx, owner, ownerEmail);
  const created = await auth(owner, "organization/create", {
    name: "Leaving Co",
    slug: `leaving-${run}`,
  });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id as string;
  const second = await auth(owner, "organization/create", {
    name: "Staying Co",
    slug: `staying-${run}`,
  });
  other = second.body.id as string;

  await signUpVerified(ctx, admin, adminEmail);
  await auth(owner, "organization/invite-member", {
    email: adminEmail,
    role: "admin",
    organizationId: ws,
  });
  const { url } = await emailFromOutbox(ctx.container, adminEmail, "invite");
  await auth(admin, "organization/accept-invitation", {
    invitationId: String(url).split("/").at(-1),
  });

  const monitor = await api(owner, "post", "/monitors").send({
    settings: { name: "Shop", regions: ["eu-central"], minFailingRegions: 1 },
    config: { type: "tcp", host: "example.com", port: 443 },
  });
  expect(monitor.status, monitor.text).toBe(201);
  monitorId = monitor.body.id as string;
  const page = await api(owner, "post", "/status-pages").send({
    name: "Leaving Co status",
    slug: `leaving-page-${run}`,
    monitorIds: [monitorId],
  });
  expect(page.status, page.text).toBe(201);
  /* A failed check with evidence, so there is an object in storage to remove. */
  await find<ResultsModule>("results").service.ingest([
    {
      id: uuidv7(),
      monitorId,
      workspaceId: ws,
      region: "eu-central",
      checkedAt: new Date(Date.now() - 5_000).toISOString(),
      ok: false,
      latencyMs: 20,
      errorCode: "connect_refused",
      evidence: { headers: {}, bodySnippet: "refused", bodyBytes: 7, bodyTruncated: false },
    },
  ]);
}, 180_000);

afterAll(async () => {
  await ctx.container.close();
});

describe("data export", () => {
  it("gives owners and admins the workspace as one file, with secrets masked", async () => {
    const res = await api(admin, "get", "/privacy/export");
    expect(res.status, res.text).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(
      new RegExp(`^attachment; filename="workspace-${ws}-\\d{4}-\\d{2}-\\d{2}\\.json"$`),
    );
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const data = res.body as WorkspaceExport;
    expect(data.version).toBe(1);
    expect(data.workspace).toMatchObject({ id: ws, name: "Leaving Co" });
    expect(data.members).toHaveLength(2);
    expect(data.monitors).toMatchObject([{ id: monitorId, name: "Shop" }]);
    expect(data.statusPages).toHaveLength(1);
    expect(data.statusPages[0]?.page).toMatchObject({ name: "Leaving Co status" });
    expect(data.notes.join(" ")).toContain("secrets are masked");
    expect(res.text).not.toContain("scrypt");
  });

  it("is not for members of another workspace", async () => {
    const stranger = request.agent(ctx.app);
    await signUpVerified(ctx, stranger, `privacy-stranger-${run}@example.com`);
    expect((await api(stranger, "get", "/privacy/export")).status).toBeGreaterThanOrEqual(403);
  });
});

describe("workspace deletion", () => {
  it("is asked for by an owner, who types the workspace's name", async () => {
    expect((await api(owner, "get", "/privacy/deletion")).body).toEqual({
      scheduled: false,
      requestedAt: null,
      requestedBy: null,
      deleteAfter: null,
    });
    const byAdmin = await api(admin, "post", "/privacy/deletion").send({ confirm: "Leaving Co" });
    expect(byAdmin.status).toBe(403);
    const wrongName = await api(owner, "post", "/privacy/deletion").send({ confirm: "leaving" });
    expect(wrongName.status).toBe(400);
    expect((await api(owner, "get", "/privacy/deletion")).body.scheduled).toBe(false);
  });

  it("waits 30 days, stops monitoring at once and tells the owners and admins", async () => {
    const asked = await api(owner, "post", "/privacy/deletion").send({ confirm: "Leaving Co" });
    expect(asked.status, asked.text).toBe(201);
    const view = asked.body as WorkspaceDeletionView;
    expect(view).toMatchObject({ scheduled: true, requestedBy: ownerEmail });
    expect(Date.parse(view.deleteAfter ?? "") - Date.parse(view.requestedAt ?? "")).toBe(30 * DAY);

    expect((await api(owner, "get", `/monitors/${monitorId}`)).body.paused).toBe(true);
    for (const to of [ownerEmail, adminEmail]) {
      expect(await emailFromOutbox(ctx.container, to, "workspace-deletion")).toMatchObject({
        workspaceName: "Leaving Co",
        requestedBy: ownerEmail,
        deleteAfter: view.deleteAfter,
        monitors: 1,
      });
    }
    /* Asking again changes nothing: the first date stands. */
    clock.advance(DAY);
    const again = await api(owner, "post", "/privacy/deletion").send({ confirm: "Leaving Co" });
    expect(again.body.deleteAfter).toBe(view.deleteAfter);
    /* Nothing is removed while it waits. */
    expect(await privacy().eraseDue()).toBe(0);
    expect((await api(owner, "get", "/privacy/export")).status).toBe(200);
  });

  it("can be cancelled by an owner, and asked for again", async () => {
    expect((await api(admin, "delete", "/privacy/deletion")).status).toBe(403);
    const cancelled = await api(owner, "delete", "/privacy/deletion");
    expect(cancelled.body.scheduled).toBe(false);
    clock.advance(40 * DAY);
    expect(await privacy().eraseDue()).toBe(0);
    expect((await api(owner, "get", "/me")).status).toBe(200);
    /* The monitor stays paused until someone resumes it. */
    expect((await api(owner, "get", `/monitors/${monitorId}`)).body.paused).toBe(true);

    const asked = await api(owner, "post", "/privacy/deletion").send({ confirm: "Leaving Co" });
    expect(asked.status, asked.text).toBe(201);
  });

  it("is refused while the workspace has a subscription or client workspaces", async () => {
    const start = new Date(Date.now() - DAY).toISOString();
    const end = new Date(Date.now() + 400 * DAY).toISOString();
    await ctx.container.infra.db.execute(sql`
      insert into subscriptions (id, workspace_id, paddle_subscription_id, paddle_customer_id, status,
        plan_key, billing_interval, items, period_start, period_end, paid_period_start, paid_period_end,
        last_event_at)
      values (${newId()}, ${other}, ${`sub_${run}`}, ${`ctm_${run}`}, 'active', 'business', 'month',
        '[]'::jsonb, ${start}::timestamptz, ${end}::timestamptz, ${start}::timestamptz, ${end}::timestamptz,
        ${start}::timestamptz)`);
    const subscribed = await api(owner, "post", "/privacy/deletion", other).send({
      confirm: "Staying Co",
    });
    expect(subscribed.status).toBe(409);
    expect(subscribed.body.detail).toContain("Cancel it on the Billing page");

    const client = await api(owner, "post", "/client-workspaces", other).send({ name: "A client" });
    expect(client.status, client.text).toBe(201);
    await ctx.container.infra.db.execute(
      sql`delete from subscriptions where workspace_id = ${other}`,
    );
    const withClients = await api(owner, "post", "/privacy/deletion", other).send({
      confirm: "Staying Co",
    });
    expect(withClients.status).toBe(409);
    expect(withClients.body.detail).toContain("client workspaces first");
  });

  it("erases everything once the 30 days are over, and only that workspace", async () => {
    const before = await rowsLeft(ws);
    expect(Object.keys(before)).toEqual(
      expect.arrayContaining(["monitors", "status_pages", "workspace_settings", "check_results"]),
    );
    const stored = [...ctx.objects.objects.keys()].filter((key) => key.includes(ws));
    expect(stored.length).toBeGreaterThan(0);
    const othersBefore = await rowsLeft(other);

    clock.advance(29 * DAY);
    expect(await privacy().eraseDue()).toBe(0);
    clock.advance(2 * DAY);
    expect(await privacy().eraseDue()).toBe(1);

    expect(await rowsLeft(ws)).toEqual({});
    expect(await rows(sql`select 1 from organization where id = ${ws}`)).toEqual([]);
    expect(await rows(sql`select 1 from member where organization_id = ${ws}`)).toEqual([]);
    expect([...ctx.objects.objects.keys()].filter((key) => key.includes(ws))).toEqual([]);
    expect(
      await rows(sql`select objects from workspace_erasures where erased_workspace_id = ${ws}`),
    ).toEqual([{ objects: stored.length }]);

    /* The people keep their accounts, and the other workspace is untouched. */
    expect((await api(owner, "get", "/me")).status).toBeGreaterThanOrEqual(403);
    expect((await api(owner, "get", "/me", other)).status).toBe(200);
    expect(await rowsLeft(other)).toEqual(othersBefore);
    expect(await rows(sql`select 1 from "user" where email = ${adminEmail}`)).toHaveLength(1);
    /* A second run finds nothing to do. */
    expect(await privacy().eraseDue()).toBe(0);
  });
});
