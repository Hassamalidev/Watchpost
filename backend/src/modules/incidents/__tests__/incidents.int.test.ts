/*
 * P1-T11 AC through the real composition: list and detail (by ID and by number), manual incidents,
 * acknowledge, resolve, comment and false alarm. Every action writes a timeline event and an outbox
 * event; roles are enforced (viewers read only) and other workspaces see nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import type { IncidentsModule } from "../index.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  emailFromOutbox,
  signUpVerified,
} from "../../../__tests__/helpers/container-app.js";

let ctx: ReturnType<typeof buildContainerApp>;
let owner: TestAgent;
let member: TestAgent;
let viewer: TestAgent;
let stranger: TestAgent;
let ws: string;
let memberId: string;
let monitorId: string;

const post = (agent: TestAgent, path: string, body: object = {}) =>
  agent.post(path).set("Origin", WEB_ORIGIN).send(body);
const get = (agent: TestAgent, path: string) => agent.get(path).set("Origin", WEB_ORIGIN);
const unique = (who: string) => `${who}-${randomBytes(4).toString("hex")}@example.com`;
const base = () => `/api/w/${ws}/incidents`;

async function createWorkspace(agent: TestAgent, name: string) {
  const res = await post(agent, "/api/auth/organization/create", {
    name,
    slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomBytes(4).toString("hex")}`,
  });
  expect(res.status, res.text).toBe(200);
  return res.body.id as string;
}

async function invite(agent: TestAgent, email: string, role: "member" | "viewer") {
  await signUpVerified(ctx, agent, email);
  const res = await post(owner, "/api/auth/organization/invite-member", {
    email,
    role,
    organizationId: ws,
  });
  expect(res.status, res.text).toBe(200);
  const { url } = await emailFromOutbox(ctx.container, email, "invite");
  const invitationId = String(url).split("/").at(-1);
  const accept = await post(agent, "/api/auth/organization/accept-invitation", { invitationId });
  expect(accept.status, accept.text).toBe(200);
}

const timelineTypes = async (ref: string | number) =>
  ((await get(owner, `${base()}/${ref}`)).body.timeline as Array<{ type: string }>).map(
    (e) => e.type,
  );
const outboxTypes = (incidentId: string) =>
  ctx.container.infra.db
    .execute<{ type: string }>(
      sql`select type from outbox_events where payload->>'incidentId' = ${incidentId} order by created_at, id`,
    )
    .then((r) => r.rows.map((row) => row.type));

beforeAll(async () => {
  /* Four sign-ups from one IP would hit Better Auth's per-IP limit. */
  ctx = buildContainerApp({ authRateLimit: false });
  owner = request.agent(ctx.app);
  member = request.agent(ctx.app);
  viewer = request.agent(ctx.app);
  stranger = request.agent(ctx.app);
  await signUpVerified(ctx, owner, unique("inc-owner"));
  ws = await createWorkspace(owner, "Incidents Co");
  await invite(member, unique("inc-member"), "member");
  await invite(viewer, unique("inc-viewer"), "viewer");
  await signUpVerified(ctx, stranger, unique("inc-stranger"));
  await createWorkspace(stranger, "Other Co");

  const me = await get(member, `/api/w/${ws}/me`);
  expect(me.status, me.text).toBe(200);
  memberId = me.body.userId;

  const monitor = await post(owner, `/api/w/${ws}/monitors`, {
    settings: { name: "Checkout", regions: ["eu-central"] },
    config: { type: "tcp", host: "example.com", port: 443 },
  });
  expect(monitor.status, monitor.text).toBe(201);
  monitorId = monitor.body.id;
});

afterAll(async () => {
  await ctx.container.close();
});

describe("incidents API", () => {
  let incident: { id: string; number: number };

  it("members open incidents by hand with the next workspace number", async () => {
    const res = await post(member, base(), {
      title: "Payments are slow",
      severity: "critical",
      note: "Customers report timeouts at checkout.",
    });
    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({
      source: "manual",
      status: "triggered",
      severity: "critical",
      title: "Payments are slow",
    });
    incident = res.body;
    expect(incident.number).toBeGreaterThanOrEqual(1);

    const second = await post(member, base(), { title: "Second" });
    expect(second.body.number).toBe(incident.number + 1);
    expect(second.body.severity).toBe("high");

    expect(await timelineTypes(incident.id)).toEqual(["triggered", "comment"]);
    expect(await outboxTypes(incident.id)).toEqual(["incident.triggered"]);
  });

  it("finds an incident by ID or number, and lists with filters and a cursor", async () => {
    const byNumber = await get(viewer, `${base()}/${incident.number}`);
    expect(byNumber.status, byNumber.text).toBe(200);
    expect(byNumber.body.id).toBe(incident.id);
    expect(byNumber.body.comments).toEqual([
      expect.objectContaining({
        body: "Customers report timeouts at checkout.",
        authorId: memberId,
      }),
    ]);

    const list = await get(viewer, `${base()}?status=open&limit=1`);
    expect(list.status, list.text).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.nextCursor).toEqual(expect.any(String));
    const next = await get(viewer, `${base()}?status=open&limit=1&cursor=${list.body.nextCursor}`);
    expect(next.body.data[0].id).not.toBe(list.body.data[0].id);

    const critical = await get(viewer, `${base()}?severity=critical`);
    expect(critical.body.data.map((i: { id: string }) => i.id)).toEqual([incident.id]);

    expect((await get(owner, `${base()}/999999`)).status).toBe(404);
    expect((await get(owner, `${base()}/not-a-ref`)).status).toBe(400);
    expect((await get(owner, `${base()}?status=bogus`)).status).toBe(400);
  });

  it("acknowledge records who and when, once", async () => {
    const res = await post(member, `${base()}/${incident.number}/acknowledge`);
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ status: "acknowledged", acknowledgedBy: memberId });
    expect(res.body.acknowledgedAt).toEqual(expect.any(String));

    const again = await post(member, `${base()}/${incident.id}/acknowledge`);
    expect(again.status).toBe(200);
    expect(await timelineTypes(incident.id)).toEqual(["triggered", "comment", "acknowledged"]);
    expect(await outboxTypes(incident.id)).toEqual(["incident.triggered", "incident.acknowledged"]);
  });

  it("comments and false-alarm flags go on the timeline", async () => {
    const comment = await post(member, `${base()}/${incident.id}/comments`, {
      body: "Rolling back the deploy.",
    });
    expect(comment.status, comment.text).toBe(201);
    expect(comment.body).toMatchObject({ body: "Rolling back the deploy.", authorId: memberId });
    expect((await post(member, `${base()}/${incident.id}/comments`, { body: "  " })).status).toBe(
      400,
    );

    const marked = await post(member, `${base()}/${incident.id}/false-alarm`, { falseAlarm: true });
    expect(marked.body.falseAlarm).toBe(true);
    await post(member, `${base()}/${incident.id}/false-alarm`, { falseAlarm: true });
    const cleared = await post(member, `${base()}/${incident.id}/false-alarm`, {
      falseAlarm: false,
    });
    expect(cleared.body.falseAlarm).toBe(false);

    expect(await timelineTypes(incident.id)).toEqual([
      "triggered",
      "comment",
      "acknowledged",
      "comment",
      "false_alarm_marked",
      "false_alarm_cleared",
    ]);
    expect(await outboxTypes(incident.id)).toContain("incident.false_alarm_marked");
  });

  it("resolve closes the incident once; a resolved incident can't be acknowledged", async () => {
    const res = await post(member, `${base()}/${incident.id}/resolve`);
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({
      status: "resolved",
      resolvedBy: memberId,
      autoResolved: false,
    });
    expect((await post(member, `${base()}/${incident.id}/resolve`)).status).toBe(200);
    expect((await post(member, `${base()}/${incident.id}/acknowledge`)).status).toBe(409);

    const types = await timelineTypes(incident.id);
    expect(types.at(-1)).toBe("resolved");
    expect(types.filter((t) => t === "resolved")).toHaveLength(1);
    expect(await outboxTypes(incident.id)).toContain("incident.resolved");

    const open = await get(owner, `${base()}?status=open`);
    expect(open.body.data.map((i: { id: string }) => i.id)).not.toContain(incident.id);
    const resolved = await get(owner, `${base()}?status=resolved`);
    expect(resolved.body.data.map((i: { id: string }) => i.id)).toContain(incident.id);
  });
});

describe("monitor incidents", () => {
  it("a monitor can't have two open incidents, even by hand", async () => {
    const incidents = ctx.container.modules.find((m) => m.name === "incidents") as IncidentsModule;
    const opened = await ctx.container.infra.db.transaction((tx) =>
      incidents.service.openForMonitor(tx, {
        workspaceId: ws,
        monitorId,
        title: "Checkout is down",
        severity: "high",
        causeCode: "connect_refused",
        failingRegions: ["eu-central"],
      }),
    );
    expect(opened.created).toBe(true);

    const manual = await post(member, base(), { title: "Checkout again", monitorId });
    expect(manual.status).toBe(409);

    const filtered = await get(owner, `${base()}?monitorId=${monitorId}`);
    expect(filtered.body.data).toEqual([
      expect.objectContaining({
        id: opened.incident.id,
        source: "monitor",
        causeCode: "connect_refused",
      }),
    ]);
  });

  it("a monitor from another workspace is not found", async () => {
    const theirs = await post(stranger, `/api/w/${ws}/incidents`, { title: "x" });
    expect(theirs.status).toBe(404);
    const other = await post(member, base(), {
      title: "Unknown monitor",
      monitorId: "0190a000-0000-7000-8000-000000000000",
    });
    expect(other.status).toBe(404);
  });
});

describe("permissions", () => {
  it("viewers read but can't act", async () => {
    const [latest] = (await get(viewer, base())).body.data as Array<{ id: string }>;
    expect(latest).toBeDefined();
    const id = latest?.id ?? "";
    expect((await get(viewer, `${base()}/${id}`)).status).toBe(200);
    expect((await post(viewer, base(), { title: "Nope" })).status).toBe(403);
    expect((await post(viewer, `${base()}/${id}/acknowledge`)).status).toBe(403);
    expect((await post(viewer, `${base()}/${id}/resolve`)).status).toBe(403);
    expect((await post(viewer, `${base()}/${id}/comments`, { body: "hi" })).status).toBe(403);
    expect((await post(viewer, `${base()}/${id}/false-alarm`, { falseAlarm: true })).status).toBe(
      403,
    );
  });

  it("other workspaces see nothing", async () => {
    const [latest] = (await get(owner, base())).body.data as Array<{ id: string; number: number }>;
    expect((await get(stranger, base())).status).toBe(404);
    expect((await get(stranger, `${base()}/${latest?.id}`)).status).toBe(404);
    expect((await post(stranger, `${base()}/${latest?.id}/resolve`)).status).toBe(404);
  });

  it("signed-out requests are rejected", async () => {
    expect((await request(ctx.app).get(base()).set("Origin", WEB_ORIGIN)).status).toBe(401);
  });
});
