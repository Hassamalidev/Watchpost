/*
 * P4-T02a against the real container: a member's contact methods (the account email comes verified,
 * a second address needs its emailed code), personal rules per urgency, and the fan-out timing
 * alerting will send from (PRODUCT.md §6.5, §9.5).
 */
import { randomBytes } from "node:crypto";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContactMethodView, NotificationRulesView } from "@app/shared";
import { createWorkspaceScope } from "../../../core/workspace-scope.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  emailFromOutbox,
  signUpVerified,
} from "../../../__tests__/helpers/container-app.js";
import type { ContactsModule } from "../index.js";

const ctx = buildContainerApp({ authRateLimit: false });
const run = randomBytes(4).toString("hex");
const ownerEmail = `contacts-owner-${run}@example.com`;
const responderEmail = `contacts-responder-${run}@example.com`;
const viewerEmail = `contacts-viewer-${run}@example.com`;
const secondEmail = `contacts-second-${run}@example.com`;

let owner: TestAgent;
let responder: TestAgent;
let viewer: TestAgent;
let ws = "";
const userIds: Record<string, string> = {};

const contacts = () =>
  (ctx.container.modules.find((m) => m.name === "contacts") as ContactsModule).service;
const api = (agent: TestAgent, method: "get" | "post" | "put" | "delete", path: string) =>
  agent[method](`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN);
const auth = (agent: TestAgent, path: string, body: object) =>
  agent.post(`/api/auth/organization${path}`).set("Origin", WEB_ORIGIN).send(body);

async function methodsOf(agent: TestAgent): Promise<ContactMethodView[]> {
  const res = await api(agent, "get", "/me/contact-methods");
  expect(res.status, res.text).toBe(200);
  return res.body.data as ContactMethodView[];
}

async function codeFor(address: string): Promise<string> {
  return String((await emailFromOutbox(ctx.container, address, "contact-code")).code);
}

beforeAll(async () => {
  owner = request.agent(ctx.app);
  responder = request.agent(ctx.app);
  viewer = request.agent(ctx.app);
  await signUpVerified(ctx, owner, ownerEmail);
  await signUpVerified(ctx, responder, responderEmail);
  await signUpVerified(ctx, viewer, viewerEmail);
  const created = await auth(owner, "/create", { name: "Contacts", slug: `contacts-${run}` });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id as string;
  for (const [agent, email, role] of [
    [responder, responderEmail, "responder"],
    [viewer, viewerEmail, "viewer"],
  ] as const) {
    const invite = await auth(owner, "/invite-member", { email, role, organizationId: ws });
    expect(invite.status, invite.text).toBe(200);
    const accept = await auth(agent, "/accept-invitation", { invitationId: invite.body.id });
    expect(accept.status, accept.text).toBe(200);
  }
  const members = await api(owner, "get", "/members");
  for (const m of members.body.data as { userId: string; email: string }[]) {
    userIds[m.email] = m.userId;
  }
}, 120_000);

afterAll(async () => {
  await ctx.container.close();
});

describe("contact methods", () => {
  it("starts everyone who can be paged with their verified account email and default rules", async () => {
    const methods = await methodsOf(responder);
    expect(methods).toHaveLength(1);
    expect(methods[0]).toMatchObject({ type: "email", address: responderEmail, verified: true });

    const rules = await api(responder, "get", "/me/notification-rules");
    expect(rules.status, rules.text).toBe(200);
    expect(rules.body as NotificationRulesView).toEqual({
      high: [{ contactMethodId: methods[0]?.id, delayMinutes: 0 }],
      low: [{ contactMethodId: methods[0]?.id, delayMinutes: 0 }],
    });
  });

  it("is closed to viewers, who are never paged", async () => {
    expect((await api(viewer, "get", "/me/contact-methods")).status).toBe(403);
    expect((await api(viewer, "get", "/me/notification-rules")).status).toBe(403);
  });

  it("adds a second address unverified, emails a code, and verifies with it", async () => {
    const added = await api(owner, "post", "/me/contact-methods").send({
      type: "email",
      address: secondEmail.toUpperCase(),
      label: "Personal",
    });
    expect(added.status, added.text).toBe(201);
    expect(added.body).toMatchObject({ address: secondEmail, label: "Personal", verified: false });
    const id = added.body.id as string;

    const again = await api(owner, "post", "/me/contact-methods").send({
      type: "email",
      address: secondEmail,
    });
    expect(again.status).toBe(409);

    /* An unverified method can't be used in a rule. */
    const early = await api(owner, "put", "/me/notification-rules/high").send({
      rules: [{ contactMethodId: id, delayMinutes: 0 }],
    });
    expect(early.status, early.text).toBe(400);

    const code = await codeFor(secondEmail);
    expect(code).toMatch(/^\d{6}$/);
    const wrongCode = code === "000000" ? "000001" : "000000";
    const wrong = await api(owner, "post", `/me/contact-methods/${id}/confirm`).send({
      code: wrongCode,
    });
    expect(wrong.status).toBe(400);

    const confirmed = await api(owner, "post", `/me/contact-methods/${id}/confirm`).send({ code });
    expect(confirmed.status, confirmed.text).toBe(200);
    expect(confirmed.body.verified).toBe(true);

    /* A newly verified email joins both urgencies at once. */
    const rules = (await api(owner, "get", "/me/notification-rules")).body as NotificationRulesView;
    expect(rules.high.map((r) => r.contactMethodId)).toContain(id);
    expect(rules.low.map((r) => r.contactMethodId)).toContain(id);
  });

  it("locks a code after five wrong guesses and limits codes to three an hour", async () => {
    const address = `contacts-locked-${run}@example.com`;
    const added = await api(owner, "post", "/me/contact-methods").send({ type: "email", address });
    expect(added.status, added.text).toBe(201);
    const id = added.body.id as string;
    const code = await codeFor(address);
    const wrongCode = code === "111111" ? "222222" : "111111";
    for (let i = 0; i < 5; i += 1) {
      const res = await api(owner, "post", `/me/contact-methods/${id}/confirm`).send({
        code: wrongCode,
      });
      expect(res.status).toBe(400);
    }
    const locked = await api(owner, "post", `/me/contact-methods/${id}/confirm`).send({ code });
    expect(locked.status).toBe(429);

    /* Adding sent the first code; two more are allowed this hour. */
    expect((await api(owner, "post", `/me/contact-methods/${id}/code`)).status).toBe(201);
    expect((await api(owner, "post", `/me/contact-methods/${id}/code`)).status).toBe(201);
    expect((await api(owner, "post", `/me/contact-methods/${id}/code`)).status).toBe(429);

    /* A fresh code clears the lock. */
    const fresh = await codeFor(address);
    const confirmed = await api(owner, "post", `/me/contact-methods/${id}/confirm`).send({
      code: fresh,
    });
    expect(confirmed.status, confirmed.text).toBe(200);
  });

  it("refuses phone methods until SMS and voice arrive, and anything that isn't an email", async () => {
    const sms = await api(owner, "post", "/me/contact-methods").send({
      type: "sms",
      address: "+14155550123",
    });
    expect(sms.status).toBe(400);
    const bad = await api(owner, "post", "/me/contact-methods").send({
      type: "email",
      address: "not-an-email",
    });
    expect(bad.status).toBe(400);
  });

  it("keeps other members' methods out of reach", async () => {
    const mine = await methodsOf(owner);
    const theirs = await api(responder, "delete", `/me/contact-methods/${mine[0]?.id}`);
    expect(theirs.status).toBe(404);
    const rule = await api(responder, "put", "/me/notification-rules/high").send({
      rules: [{ contactMethodId: mine[0]?.id, delayMinutes: 0 }],
    });
    expect(rule.status).toBe(400);
  });

  it("won't remove the only verified method", async () => {
    const [only] = await methodsOf(responder);
    const removed = await api(responder, "delete", `/me/contact-methods/${only?.id}`);
    expect(removed.status).toBe(409);
  });
});

describe("personal rules and fan-out timing", () => {
  const from = new Date("2026-10-06T12:00:00.000Z");
  const system = () => createWorkspaceScope({ workspaceId: ws });
  const offsets = (steps: { address: string; dueAt: Date }[]) =>
    steps.map((s) => `${s.address}+${(s.dueAt.getTime() - from.getTime()) / 60_000}m`);

  it("replaces the rules of one urgency and leaves the other alone", async () => {
    const methods = await methodsOf(owner);
    const account = methods.find((m) => m.address === ownerEmail);
    const second = methods.find((m) => m.address === secondEmail);
    const replaced = await api(owner, "put", "/me/notification-rules/high").send({
      rules: [
        { contactMethodId: second?.id, delayMinutes: 0 },
        { contactMethodId: account?.id, delayMinutes: 7 },
      ],
    });
    expect(replaced.status, replaced.text).toBe(200);
    const rules = replaced.body as NotificationRulesView;
    expect(rules.high).toEqual([
      { contactMethodId: second?.id, delayMinutes: 0 },
      { contactMethodId: account?.id, delayMinutes: 7 },
    ]);
    expect(rules.low.length).toBeGreaterThanOrEqual(2);

    const twice = await api(owner, "put", "/me/notification-rules/high").send({
      rules: [
        { contactMethodId: second?.id, delayMinutes: 0 },
        { contactMethodId: second?.id, delayMinutes: 5 },
      ],
    });
    expect(twice.status).toBe(400);
  });

  it("times each contact method from the moment the incident reaches the user", async () => {
    const high = await contacts().fanOut(system(), userIds[ownerEmail] ?? "", "high", from);
    expect(offsets(high)).toEqual([`${secondEmail}+0m`, `${ownerEmail}+7m`]);
    expect(high[1]?.dueAt.toISOString()).toBe("2026-10-06T12:07:00.000Z");

    const low = await contacts().fanOut(system(), userIds[ownerEmail] ?? "", "low", from);
    expect(low.every((s) => s.dueAt.getTime() === from.getTime())).toBe(true);
  });

  it("reaches a member who never opened their settings, by account email at once", async () => {
    const address = `contacts-late-${run}@example.com`;
    const late = request.agent(ctx.app);
    await signUpVerified(ctx, late, address);
    const invite = await auth(owner, "/invite-member", {
      email: address,
      role: "member",
      organizationId: ws,
    });
    await auth(late, "/accept-invitation", { invitationId: invite.body.id });
    const members = await api(owner, "get", "/members");
    const userId = (members.body.data as { userId: string; email: string }[]).find(
      (m) => m.email === address,
    )?.userId;
    const plan = await contacts().fanOut(system(), userId ?? "", "high", from);
    expect(offsets(plan)).toEqual([`${address}+0m`]);
  });

  it("plans nothing for someone who isn't in the workspace", async () => {
    const stranger = "0190e2e0-0000-7000-8000-00000000ffff";
    expect(await contacts().fanOut(system(), stranger, "high", from)).toEqual([]);
  });
});
