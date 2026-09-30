/*
 * Channels and alert policies through the real composition: admins manage channels (config stored
 * encrypted), viewers only see names and health, unknown or unavailable types are refused, every
 * workspace has a default policy that can't be deleted, and policies only accept the workspace's own
 * channels. The email adapter turns an alert into one idempotent email per recipient.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import type { ChannelsModule } from "../index.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  emailFromOutbox,
  signUpVerified,
} from "../../../__tests__/helpers/container-app.js";

let ctx: ReturnType<typeof buildContainerApp>;
let owner: TestAgent;
let viewer: TestAgent;
let stranger: TestAgent;
let ws: string;

const send = (agent: TestAgent, method: "post" | "patch" | "delete", path: string, body?: object) =>
  agent[method](path).set("Origin", WEB_ORIGIN).send(body);
const get = (agent: TestAgent, path: string) => agent.get(path).set("Origin", WEB_ORIGIN);
const unique = (who: string) => `${who}-${randomBytes(4).toString("hex")}@example.com`;

async function createWorkspace(agent: TestAgent, name: string) {
  const res = await send(agent, "post", "/api/auth/organization/create", {
    name,
    slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomBytes(4).toString("hex")}`,
  });
  expect(res.status, res.text).toBe(200);
  return res.body.id as string;
}

beforeAll(async () => {
  ctx = buildContainerApp({ authRateLimit: false });
  owner = request.agent(ctx.app);
  viewer = request.agent(ctx.app);
  stranger = request.agent(ctx.app);
  await signUpVerified(ctx, owner, unique("chan-owner"));
  ws = await createWorkspace(owner, "Channels Co");

  const viewerEmail = unique("chan-viewer");
  await signUpVerified(ctx, viewer, viewerEmail);
  const invite = await send(owner, "post", "/api/auth/organization/invite-member", {
    email: viewerEmail,
    role: "viewer",
    organizationId: ws,
  });
  expect(invite.status, invite.text).toBe(200);
  const { url } = await emailFromOutbox(ctx.container, viewerEmail, "invite");
  const accepted = await send(viewer, "post", "/api/auth/organization/accept-invitation", {
    invitationId: String(url).split("/").at(-1),
  });
  expect(accepted.status, accepted.text).toBe(200);

  await signUpVerified(ctx, stranger, unique("chan-stranger"));
  await createWorkspace(stranger, "Elsewhere");
});

afterAll(async () => {
  await ctx.container.close();
});

describe("channels API", () => {
  let channelId: string;

  it("admins create email channels; the config is stored encrypted", async () => {
    const res = await send(owner, "post", `/api/w/${ws}/channels`, {
      type: "email",
      name: "On-call inbox",
      config: { to: ["oncall@example.com", "cto@example.com"] },
    });
    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({
      type: "email",
      name: "On-call inbox",
      status: "healthy",
      config: { to: ["oncall@example.com", "cto@example.com"] },
    });
    channelId = res.body.id;

    const [row] = (
      await ctx.container.infra.db.execute<{ config_enc: string }>(
        sql`select config_enc from channels where id = ${channelId}`,
      )
    ).rows;
    expect(row?.config_enc.startsWith("v1.")).toBe(true);
    expect(row?.config_enc).not.toContain("oncall@example.com");
  });

  it("refuses bad configs and channel types that aren't available yet", async () => {
    const bad = await send(owner, "post", `/api/w/${ws}/channels`, {
      type: "email",
      name: "Broken",
      config: { to: ["not-an-email"] },
    });
    expect(bad.status).toBe(400);
    const slack = await send(owner, "post", `/api/w/${ws}/channels`, {
      type: "slack",
      name: "Slack",
      config: {},
    });
    expect(slack.status).toBe(400);
    const unknown = await send(owner, "post", `/api/w/${ws}/channels`, {
      type: "carrier-pigeon",
      name: "Birds",
      config: {},
    });
    expect(unknown.status).toBe(400);
  });

  it("updates names and configs, and deletes", async () => {
    const renamed = await send(owner, "patch", `/api/w/${ws}/channels/${channelId}`, {
      name: "Ops inbox",
      config: { to: ["ops@example.com"] },
    });
    expect(renamed.status, renamed.text).toBe(200);
    expect(renamed.body).toMatchObject({ name: "Ops inbox", config: { to: ["ops@example.com"] } });

    const temp = await send(owner, "post", `/api/w/${ws}/channels`, {
      type: "email",
      name: "Temp",
      config: { to: ["temp@example.com"] },
    });
    expect((await send(owner, "delete", `/api/w/${ws}/channels/${temp.body.id}`)).status).toBe(204);
    expect((await get(owner, `/api/w/${ws}/channels/${temp.body.id}`)).status).toBe(404);
  });

  it("viewers see names and health but not configs, and can't change anything", async () => {
    const list = await get(viewer, `/api/w/${ws}/channels`);
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([
      expect.objectContaining({ id: channelId, name: "Ops inbox", status: "healthy" }),
    ]);
    expect(list.body.data[0].config).toBeUndefined();
    expect((await get(viewer, `/api/w/${ws}/channels/${channelId}`)).status).toBe(403);
    expect(
      (
        await send(viewer, "post", `/api/w/${ws}/channels`, {
          type: "email",
          name: "x",
          config: {},
        })
      ).status,
    ).toBe(403);
    expect((await send(viewer, "delete", `/api/w/${ws}/channels/${channelId}`)).status).toBe(403);
  });

  it("other workspaces see nothing", async () => {
    expect((await get(stranger, `/api/w/${ws}/channels`)).status).toBe(404);
  });

  it("the email adapter sends one idempotent email per recipient", async () => {
    const channels = ctx.container.modules.find((m) => m.name === "channels") as ChannelsModule;
    const event = {
      kind: "triggered" as const,
      workspace: { id: ws, name: "Channels Co" },
      incident: {
        id: "0190a000-0000-7000-8000-00000000abcd",
        number: 7,
        title: "API is down",
        severity: "critical" as const,
        status: "triggered" as const,
        causeCode: "connect_refused",
        failingRegions: ["eu-central"],
        monitorName: "API",
        startedAt: new Date().toISOString(),
        resolvedAt: null,
        durationSeconds: 60,
        url: `${WEB_ORIGIN}/w/${ws}/incidents/7`,
      },
      actor: null,
      at: new Date().toISOString(),
    };
    await channels.service.deliver({ channelId, event, idempotencyKey: "delivery.test-1" });
    await channels.service.deliver({ channelId, event, idempotencyKey: "delivery.test-1" });
    const emails = (
      await ctx.container.infra.db.execute<{
        payload: {
          to: string;
          template: string;
          idempotencyKey: string;
          data: { subject: string };
        };
      }>(
        sql`select payload from outbox_events where type = 'email.requested' and payload->>'template' = 'alert' and payload->>'idempotencyKey' like 'delivery.test-1:%'`,
      )
    ).rows.map((r) => r.payload);
    expect(new Set(emails.map((e) => e.idempotencyKey))).toEqual(
      new Set(["delivery.test-1:ops@example.com"]),
    );
    expect(emails[0]?.data.subject).toBe("[Critical] #7 API is down");
  });
});

describe("alert policies API", () => {
  it("every workspace has a default policy that can't be deleted", async () => {
    const list = await get(viewer, `/api/w/${ws}/alert-policies`);
    expect(list.status, list.text).toBe(200);
    const [policy] = list.body.data;
    expect(policy).toMatchObject({
      name: "Default",
      isDefault: true,
      rules: { channelIds: [], events: { triggered: true, resolved: true } },
    });
    expect((await send(owner, "delete", `/api/w/${ws}/alert-policies/${policy.id}`)).status).toBe(
      409,
    );
  });

  it("policies only accept this workspace's channels, and only admins change them", async () => {
    const channels = (await get(owner, `/api/w/${ws}/channels`)).body.data as Array<{ id: string }>;
    const created = await send(owner, "post", `/api/w/${ws}/alert-policies`, {
      name: "Critical only",
      rules: { channelIds: [channels[0]?.id], events: { reminder: false } },
    });
    expect(created.status, created.text).toBe(201);
    expect(created.body.rules.events).toMatchObject({ reminder: false, triggered: true });

    const foreign = await send(owner, "post", `/api/w/${ws}/alert-policies`, {
      name: "Foreign",
      rules: { channelIds: ["0190a000-0000-7000-8000-000000000001"] },
    });
    expect(foreign.status).toBe(400);
    expect(
      (await send(viewer, "post", `/api/w/${ws}/alert-policies`, { name: "x", rules: {} })).status,
    ).toBe(403);

    const renamed = await send(owner, "patch", `/api/w/${ws}/alert-policies/${created.body.id}`, {
      name: "Critical alerts",
    });
    expect(renamed.body.name).toBe("Critical alerts");
    expect(
      (await send(owner, "delete", `/api/w/${ws}/alert-policies/${created.body.id}`)).status,
    ).toBe(204);
  });
});
