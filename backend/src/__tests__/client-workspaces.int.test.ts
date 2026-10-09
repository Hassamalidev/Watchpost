/*
 * P7-T03 through the real app: an agency on Business creates client workspaces. Its owners and
 * admins run them without being added to each; the client's own people see only their workspace,
 * with the role they were invited with; the agency's plan pays for and limits all of them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { newId } from "../infra/ids.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  emailFromOutbox,
  signUpVerified,
} from "./helpers/container-app.js";

const ctx = buildContainerApp({ authRateLimit: false });
const run = randomBytes(4).toString("hex");
let owner: TestAgent;
let agencyAdmin: TestAgent;
let agencyMember: TestAgent;
let clientViewer: TestAgent;
let agency = "";
let client = "";

const api = (agent: TestAgent, method: "get" | "post", ws: string, path: string) =>
  agent[method](`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN);
const auth = (agent: TestAgent, path: string, body: object) =>
  agent.post(`/api/auth/${path}`).set("Origin", WEB_ORIGIN).send(body);

async function join(agent: TestAgent, email: string, role: string, workspaceId: string) {
  await signUpVerified(ctx, agent, email);
  const invited = await auth(owner, "organization/invite-member", {
    email,
    role,
    organizationId: workspaceId,
  });
  expect(invited.status, invited.text).toBe(200);
  const { url } = await emailFromOutbox(ctx.container, email, "invite");
  const accepted = await auth(agent, "organization/accept-invitation", {
    invitationId: String(url).split("/").at(-1),
  });
  expect(accepted.status, accepted.text).toBe(200);
}

beforeAll(async () => {
  owner = request.agent(ctx.app);
  agencyAdmin = request.agent(ctx.app);
  agencyMember = request.agent(ctx.app);
  clientViewer = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `agency-${run}@example.com`);
  const created = await auth(owner, "organization/create", {
    name: "Studio North",
    slug: `agency-${run}`,
  });
  expect(created.status, created.text).toBe(200);
  agency = created.body.id as string;
  await join(agencyAdmin, `agency-admin-${run}@example.com`, "admin", agency);
  await join(agencyMember, `agency-member-${run}@example.com`, "member", agency);
}, 180_000);

afterAll(async () => {
  await ctx.container.close();
});

describe("agency client workspaces", () => {
  it("are part of Business", async () => {
    const onTrial = await api(owner, "post", agency, "/client-workspaces").send({ name: "Bakery" });
    expect(onTrial.status).toBe(402);
    expect(onTrial.body.detail).toContain("Business plan");

    const start = new Date(Date.now() - 86_400_000).toISOString();
    const end = new Date(Date.now() + 29 * 86_400_000).toISOString();
    await ctx.container.infra.db.execute(sql`
      insert into subscriptions (id, workspace_id, paddle_subscription_id, paddle_customer_id, status,
        plan_key, billing_interval, items, period_start, period_end, paid_period_start, paid_period_end,
        last_event_at)
      values (${newId()}, ${agency}, ${`sub_${run}`}, ${`ctm_${run}`}, 'active', 'business', 'month',
        '[]'::jsonb, ${start}::timestamptz, ${end}::timestamptz, ${start}::timestamptz, ${end}::timestamptz,
        ${start}::timestamptz)`);

    const made = await api(owner, "post", agency, "/client-workspaces").send({ name: "Bakery" });
    expect(made.status, made.text).toBe(201);
    expect(made.body.name).toBe("Bakery");
    client = made.body.id as string;
    const listed = await api(owner, "get", agency, "/client-workspaces");
    expect(listed.body.data).toEqual([
      { id: client, name: "Bakery", createdAt: expect.any(String) },
    ]);
    /* Members of the agency don't manage clients. */
    expect((await api(agencyMember, "get", agency, "/client-workspaces")).status).toBe(403);
  });

  it("lets the agency's admins in as admins, and keeps its other people out", async () => {
    const me = await api(agencyAdmin, "get", client, "/me");
    expect(me.status, me.text).toBe(200);
    expect(me.body).toMatchObject({
      role: "admin",
      name: "Bakery",
      parent: { id: agency, name: "Studio North" },
    });
    expect((await api(agencyAdmin, "get", client, "/monitors")).status).toBe(200);
    expect((await api(agencyMember, "get", client, "/me")).status).toBeGreaterThanOrEqual(403);
    expect((await api(owner, "get", agency, "/me")).body).toMatchObject({
      name: "Studio North",
      parent: null,
    });
  });

  it("gives the client the agency's plan, with no trial, clients or billing of its own", async () => {
    const entitlements = await api(agencyAdmin, "get", client, "/entitlements");
    expect(entitlements.status, entitlements.text).toBe(200);
    expect(entitlements.body.plan).toBe("business");
    expect(entitlements.body.features.whiteLabel).toBe(true);
    expect(entitlements.body.limits.clientWorkspaces).toBe(0);

    const nested = await api(owner, "post", client, "/client-workspaces").send({ name: "Deeper" });
    expect(nested.status).toBe(409);
    const checkout = await api(owner, "post", client, "/billing/checkout").send({
      plan: "team",
      interval: "month",
    });
    expect(checkout.status).toBe(409);
    expect(checkout.body.detail).toContain("billed through the agency");
    const trial = await ctx.container.infra.db.execute<{ trial_ends_at: Date | null }>(
      sql`select trial_ends_at from workspace_settings where workspace_id = ${client}`,
    );
    expect(trial.rows).toEqual([{ trial_ends_at: null }]);
  });

  it("lets a client's viewer read their own workspace and nothing else", async () => {
    await join(clientViewer, `client-viewer-${run}@example.com`, "viewer", client);
    expect((await api(clientViewer, "get", client, "/me")).body).toMatchObject({
      role: "viewer",
      parent: { id: agency, name: "Studio North" },
    });
    expect((await api(clientViewer, "get", client, "/monitors")).status).toBe(200);
    const write = await api(clientViewer, "post", client, "/monitors").send({});
    expect(write.status).toBe(403);
    expect((await api(clientViewer, "get", agency, "/me")).status).toBeGreaterThanOrEqual(403);
    expect((await api(clientViewer, "get", client, "/client-workspaces")).status).toBe(403);
  });
});
