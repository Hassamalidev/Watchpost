/*
 * P7-T02 (audit log) through the real app: every change made through the app's API or the public
 * API leaves an entry without any module asking for it, changes to people come from the sign-in
 * hooks, reading the log follows the plan (security events for all, everything on Business), and it
 * exports as CSV.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import type { AuditEntryView, AuditLogPage } from "@app/shared";
import { createFakeClock } from "../core/clock.js";
import { newId } from "../infra/ids.js";
import type { AuditModule } from "../modules/audit/index.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  emailFromOutbox,
  signUpVerified,
} from "./helpers/container-app.js";

const DAY = 86_400_000;
const clock = createFakeClock(new Date());
const ctx = buildContainerApp({ authRateLimit: false, clock });
const run = randomBytes(4).toString("hex");
const ownerEmail = `audit-${run}@example.com`;
const memberEmail = `audit-member-${run}@example.com`;
let owner: TestAgent;
let member: TestAgent;
let ws = "";
let monitorId = "";

const api = (agent: TestAgent, method: "get" | "post" | "patch" | "delete", path: string) =>
  agent[method](`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN);
const auth = (agent: TestAgent, path: string, body: object) =>
  agent.post(`/api/auth/organization/${path}`).set("Origin", WEB_ORIGIN).send(body);

/* The trail writes after the answer has gone out, so the newest entries may be a moment behind. */
async function stored(count: number): Promise<Array<Record<string, unknown>>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = (
      await ctx.container.infra.db.execute<Record<string, unknown>>(
        sql`select action, category, actor_type, actor_label, target_id, detail, ip from audit_logs where workspace_id = ${ws} order by id`,
      )
    ).rows;
    if (rows.length >= count) return rows;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`fewer than ${count} audit entries were written`);
}
const log = async (query = "") =>
  (await api(owner, "get", `/audit-log${query}`)).body as AuditLogPage;

beforeAll(async () => {
  owner = request.agent(ctx.app);
  member = request.agent(ctx.app);
  await signUpVerified(ctx, owner, ownerEmail);
  const created = await owner
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "Audit Co", slug: `audit-${run}` });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id as string;
  await signUpVerified(ctx, member, memberEmail);
}, 120_000);

afterAll(async () => {
  await ctx.container.close();
});

describe("the audit trail", () => {
  it("records what changed, who did it and to what; reads and refused requests leave nothing", async () => {
    const created = await api(owner, "post", "/monitors").send({
      settings: { name: "Checkout API" },
      config: { type: "tcp", host: "example.com", port: 443 },
    });
    expect(created.status, created.text).toBe(201);
    monitorId = created.body.id as string;
    await api(owner, "post", `/monitors/${monitorId}/pause`).send({});
    await api(owner, "patch", `/monitors/${monitorId}`).send({ settings: { name: "Checkout" } });
    /* Neither of these changes anything. */
    await api(owner, "get", "/monitors");
    expect((await api(owner, "post", "/monitors").send({ settings: {} })).status).toBe(400);

    const rows = await stored(3);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      action: "monitors.create",
      category: "config",
      actor_type: "user",
      actor_label: ownerEmail,
      target_id: null,
      detail: "Checkout API",
    });
    expect(rows[0]?.ip).toEqual(expect.any(String));
    expect(rows[1]).toMatchObject({ action: "monitors.pause", target_id: monitorId, detail: null });
    expect(rows[2]).toMatchObject({
      action: "monitors.update",
      target_id: monitorId,
      detail: "Checkout",
    });
  });

  it("records what an API key did, and that the key was made, without the key", async () => {
    const key = await api(owner, "post", "/api-keys").send({
      name: "CI",
      scopes: ["incidents:write"],
    });
    expect(key.status, key.text).toBe(201);
    const opened = await api(owner, "post", "/incidents").send({ title: "Queue is stuck" });
    const acked = await request(ctx.app)
      .post(`/api/v1/incidents/${opened.body.number as number}/acknowledge`)
      .set("Authorization", `Bearer ${key.body.key as string}`);
    expect(acked.status, acked.text).toBe(200);

    const rows = await stored(6);
    expect(rows[3]).toMatchObject({
      action: "api-keys.create",
      category: "security",
      actor_label: ownerEmail,
      detail: "CI",
    });
    expect(rows[4]).toMatchObject({ action: "incidents.create", category: "incident" });
    expect(rows[5]).toMatchObject({
      action: "incidents.acknowledge",
      category: "incident",
      actor_type: "api_key",
      actor_label: "API key: CI",
      target_id: String(opened.body.number),
    });
    expect(JSON.stringify(rows)).not.toContain((key.body.key as string).slice(16));
  });

  it("records people being invited, joining, changing role and being removed", async () => {
    const invited = await auth(owner, "invite-member", {
      email: memberEmail,
      role: "member",
      organizationId: ws,
    });
    expect(invited.status, invited.text).toBe(200);
    const { url } = await emailFromOutbox(ctx.container, memberEmail, "invite");
    const accepted = await auth(member, "accept-invitation", {
      invitationId: String(url).split("/").at(-1),
    });
    expect(accepted.status, accepted.text).toBe(200);
    const memberId = accepted.body.member.id as string;
    const role = await auth(owner, "update-member-role", {
      memberId,
      role: "admin",
      organizationId: ws,
    });
    expect(role.status, role.text).toBe(200);
    const removed = await auth(owner, "remove-member", {
      memberIdOrEmail: memberEmail,
      organizationId: ws,
    });
    expect(removed.status, removed.text).toBe(200);

    const rows = (await stored(10)).slice(6);
    expect(rows.map((r) => [r.action, r.category, r.detail])).toEqual([
      ["invitation.sent", "security", `${memberEmail} as member`],
      ["member.joined", "security", `${memberEmail} as member`],
      ["member.role_changed", "security", `${memberEmail}: member to admin`],
      ["member.removed", "security", memberEmail],
    ]);
    expect(rows[0]?.actor_label).toBe(ownerEmail);
    expect(rows[1]?.actor_label).toBe(memberEmail);
  });
});

describe("reading the log", () => {
  it("shows security events on every plan, and says the rest needs Business", async () => {
    const page = await log();
    expect(page.securityOnly).toBe(true);
    expect(page.data.map((e) => e.action)).toEqual([
      "member.removed",
      "member.role_changed",
      "member.joined",
      "invitation.sent",
      "api-keys.create",
    ]);
    /* Asking for another category doesn't get around it. */
    expect((await log("?category=config")).data.every((e) => e.category === "security")).toBe(true);
    expect((await api(member, "get", "/audit-log")).status).toBe(404);
  });

  it("shows everything on Business, newest first, by category and in pages", async () => {
    const start = new Date(clock.now().getTime() - DAY).toISOString();
    const end = new Date(clock.now().getTime() + 29 * DAY).toISOString();
    await ctx.container.infra.db.execute(sql`
      insert into subscriptions (id, workspace_id, paddle_subscription_id, paddle_customer_id, status,
        plan_key, billing_interval, items, period_start, period_end, paid_period_start, paid_period_end,
        last_event_at)
      values (${newId()}, ${ws}, ${`sub_${run}`}, ${`ctm_${run}`}, 'active', 'business', 'month',
        '[]'::jsonb, ${start}::timestamptz, ${end}::timestamptz, ${start}::timestamptz, ${end}::timestamptz,
        ${start}::timestamptz)`);

    const all = await log();
    expect(all.securityOnly).toBe(false);
    expect(all.data).toHaveLength(10);
    expect(all.data[0]?.action).toBe("member.removed");
    expect(all.data.at(-1)).toMatchObject<Partial<AuditEntryView>>({
      action: "monitors.create",
      category: "config",
      actor: { type: "user", id: expect.any(String) as string, label: ownerEmail },
      detail: "Checkout API",
    });
    expect((await log("?category=incident")).data.map((e) => e.action)).toEqual([
      "incidents.acknowledge",
      "incidents.create",
    ]);

    const first = await log("?limit=4");
    expect(first.data).toHaveLength(4);
    const second = await log(`?limit=4&cursor=${first.nextCursor}`);
    const third = await log(`?limit=4&cursor=${second.nextCursor}`);
    expect(third.nextCursor).toBeNull();
    expect([...first.data, ...second.data, ...third.data].map((e) => e.id)).toEqual(
      all.data.map((e) => e.id),
    );
  });

  it("exports as CSV that a spreadsheet can't run", async () => {
    await api(owner, "patch", `/monitors/${monitorId}`).send({ settings: { name: "=SUM(A1)" } });
    await stored(11);
    const res = await api(owner, "get", "/audit-log.csv?days=30");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toBe('attachment; filename="audit-log.csv"');
    const lines = res.text.trimEnd().split("\r\n");
    expect(lines[0]).toBe("Time (UTC),Actor,Actor type,Category,Action,Target,Detail,IP");
    expect(lines).toHaveLength(12);
    expect(lines[1]).toContain(
      `,${ownerEmail},user,config,monitors.update,${monitorId},'=SUM(A1),`,
    );
    expect(lines.at(-1)).toContain(",config,monitors.create,,Checkout API,");
  });

  it("forgets entries after 400 days", async () => {
    const audit = ctx.container.modules.find((m) => m.name === "audit") as AuditModule;
    expect(await audit.service.purge()).toBe(0);
    clock.advance(401 * DAY);
    try {
      expect(await audit.service.purge()).toBeGreaterThanOrEqual(11);
    } finally {
      clock.advance(-401 * DAY);
    }
  });
});
