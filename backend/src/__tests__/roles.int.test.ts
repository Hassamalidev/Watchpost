/*
 * P4-T01, end to end against the real container: one workspace with a member in each of the six
 * roles, all invited through Better Auth, and what each can and can't do over HTTP (PRODUCT.md §6.11).
 */
import { randomBytes } from "node:crypto";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WORKSPACE_ROLES, type WorkspaceRole } from "@app/shared";
import { WEB_ORIGIN, buildContainerApp, signUpVerified } from "./helpers/container-app.js";

const ctx = buildContainerApp({ authRateLimit: false });
const run = randomBytes(4).toString("hex");
const emailOf = (role: string) => `roles-${role}-${run}@example.com`;

const agents = {} as Record<WorkspaceRole, TestAgent>;
let ws = "";

const call = (
  role: WorkspaceRole,
  method: "get" | "post" | "patch" | "delete",
  path: string,
  body?: object,
) => {
  const req = agents[role][method](`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN);
  return body === undefined ? req : req.send(body);
};
const authPost = (role: WorkspaceRole, path: string, body: object) =>
  agents[role].post(`/api/auth/organization${path}`).set("Origin", WEB_ORIGIN).send(body);

/* Who gets through: 403 for the rest. A role that gets through may still see 400 or 404 for the input. */
async function expectAllowed(
  method: "get" | "post" | "patch" | "delete",
  path: string,
  allowed: WorkspaceRole[],
  body?: object,
) {
  for (const role of WORKSPACE_ROLES) {
    const res = await call(role, method, path, body);
    if (allowed.includes(role)) {
      expect(res.status, `${role} ${method} ${path}: ${res.text}`).not.toBe(403);
      expect(res.status, `${role} ${method} ${path}: ${res.text}`).toBeLessThan(500);
    } else {
      expect(res.status, `${role} ${method} ${path}: ${res.text}`).toBe(403);
    }
  }
}

beforeAll(async () => {
  for (const role of WORKSPACE_ROLES) {
    agents[role] = request.agent(ctx.app);
    await signUpVerified(ctx, agents[role], emailOf(role));
  }
  const created = await authPost("owner", "/create", { name: "Roles", slug: `roles-${run}` });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id as string;

  for (const role of WORKSPACE_ROLES) {
    if (role === "owner") continue;
    const invite = await authPost("owner", "/invite-member", {
      email: emailOf(role),
      role,
      organizationId: ws,
    });
    expect(invite.status, `inviting a ${role}: ${invite.text}`).toBe(200);
    const accept = await authPost(role, "/accept-invitation", { invitationId: invite.body.id });
    expect(accept.status, `${role} accepting: ${accept.text}`).toBe(200);
  }
}, 120_000);

afterAll(async () => {
  await ctx.container.close();
});

const EVERYONE: WorkspaceRole[] = [...WORKSPACE_ROLES];
const NOT_BILLING: WorkspaceRole[] = ["owner", "admin", "member", "responder", "viewer"];
const RESPONDERS: WorkspaceRole[] = ["owner", "admin", "member", "responder"];
const MEMBERS: WorkspaceRole[] = ["owner", "admin", "member"];
const ADMINS: WorkspaceRole[] = ["owner", "admin"];
const BILLING_MANAGERS: WorkspaceRole[] = ["owner", "admin", "billing"];
const NOBODY_ID = "00000000-0000-7000-8000-000000000000";

describe("six roles in one workspace", () => {
  it("tells each member their own role", async () => {
    for (const role of WORKSPACE_ROLES) {
      const me = await call(role, "get", "/me");
      expect(me.status, me.text).toBe(200);
      expect(me.body.role).toBe(role);
    }
  });

  it("lets everyone but billing read monitors, incidents, maintenance, channels and deploys", async () => {
    for (const path of [
      "/monitors",
      "/monitor-states",
      "/tags",
      "/monitor-groups",
      "/heartbeats",
      "/incidents",
      "/incidents/summary",
      "/alert-tuning",
      "/maintenance-windows",
      "/alert-policies",
      "/channels",
      "/deploys",
      `/probe-tasks/${NOBODY_ID}`,
    ]) {
      await expectAllowed("get", path, NOT_BILLING);
    }
  });

  it("lets members and above change monitors and maintenance", async () => {
    await expectAllowed("post", "/monitors", MEMBERS, {});
    await expectAllowed("post", "/monitor-groups", MEMBERS, {});
    await expectAllowed("delete", `/monitors/${NOBODY_ID}`, MEMBERS);
    await expectAllowed("post", `/monitors/${NOBODY_ID}/test`, MEMBERS);
    await expectAllowed("post", "/maintenance-windows", MEMBERS, {});
    await expectAllowed("post", "/incidents", MEMBERS, {});
    await expectAllowed("post", "/incidents/999999/false-alarm", MEMBERS, {});
  });

  it("lets responders and above acknowledge, resolve and comment, and viewers only look", async () => {
    await expectAllowed("post", "/incidents/999999/acknowledge", RESPONDERS);
    await expectAllowed("post", "/incidents/999999/resolve", RESPONDERS);
    await expectAllowed("post", "/incidents/999999/comments", RESPONDERS, {});
  });

  it("keeps integrations, routing, drills, settings and the member list to admins", async () => {
    await expectAllowed("post", "/channels", ADMINS, {});
    await expectAllowed("get", `/channels/${NOBODY_ID}`, ADMINS);
    await expectAllowed("post", `/channels/${NOBODY_ID}/test`, ADMINS);
    await expectAllowed("get", "/integrations/slack/installations", ADMINS);
    await expectAllowed("post", "/alert-policies", ADMINS, {});
    await expectAllowed("post", "/phone-numbers/codes", ADMINS, {});
    await expectAllowed("patch", "/settings", ADMINS, {});
    await expectAllowed("get", "/members", ADMINS);
  });

  it("shows the plan and its meters to everyone, and lets owners, admins and billing change it", async () => {
    for (const path of [
      "/me",
      "/settings",
      "/entitlements",
      "/billing",
      "/credits",
      "/monitor-usage",
    ]) {
      await expectAllowed("get", path, EVERYONE);
    }
    await expectAllowed("post", "/billing/checkout", BILLING_MANAGERS, {});
    await expectAllowed("post", "/billing/cancel", BILLING_MANAGERS, {});
  });

  it("lists every member with the role they were invited as", async () => {
    const members = await call("admin", "get", "/members");
    expect(members.status, members.text).toBe(200);
    const byEmail = new Map(
      (members.body.data as { email: string; role: string }[]).map((m) => [m.email, m.role]),
    );
    for (const role of WORKSPACE_ROLES) expect(byEmail.get(emailOf(role))).toBe(role);
  });
});

describe("Better Auth's own endpoints", () => {
  it("lets only owners and admins invite", async () => {
    for (const role of ["member", "responder", "viewer", "billing"] as const) {
      const invite = await authPost(role, "/invite-member", {
        email: `roles-extra-${role}-${run}@example.com`,
        role: "viewer",
        organizationId: ws,
      });
      expect(invite.status, `${role}: ${invite.text}`).toBe(403);
    }
    const invite = await authPost("admin", "/invite-member", {
      email: `roles-extra-admin-${run}@example.com`,
      role: "responder",
      organizationId: ws,
    });
    expect(invite.status, invite.text).toBe(200);
  });

  it("refuses a role that doesn't exist", async () => {
    const invite = await authPost("owner", "/invite-member", {
      email: `roles-bogus-${run}@example.com`,
      role: "superuser",
      organizationId: ws,
    });
    expect(invite.status).toBeGreaterThanOrEqual(400);
    expect(invite.status).toBeLessThan(500);
  });

  it("keeps responders, viewers and billing from renaming the workspace", async () => {
    for (const role of ["responder", "viewer", "billing"] as const) {
      const update = await authPost(role, "/update", {
        organizationId: ws,
        data: { name: "Renamed" },
      });
      expect(update.status, `${role}: ${update.text}`).toBe(403);
    }
  });
});
