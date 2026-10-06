/*
 * Test app with Better Auth and the workspaces module wired like the container does, emails captured
 * in memory, plus helpers to sign up, verify and create workspaces through the real HTTP API.
 */
import { randomBytes } from "node:crypto";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { expect } from "vitest";
import { pino } from "pino";
import { createApp } from "../../app.js";
import { systemClock, type Clock } from "../../core/clock.js";
import { createAuthService } from "../../infra/auth/index.js";
import { createDb, type DbPool } from "../../infra/db/index.js";
import { createOutbox } from "../../infra/outbox/index.js";
import type { RedisClient } from "../../infra/redis.js";
import { createWorkspacesModule } from "../../modules/workspaces/index.js";
import { createMonitorsModule } from "../../modules/monitors/index.js";
import { createTokenCipher, parseKey } from "../../infra/crypto.js";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import type { PlanLimits } from "../../config/plans.js";

export const WEB_ORIGIN = "http://localhost:3000";
export const PASSWORD = "correct horse battery";

export interface CapturedEmail {
  template: string;
  to: string;
  data: Record<string, unknown>;
}

export function buildWorkspaceTestApp(options: {
  pool: DbPool;
  redis: RedisClient;
  emails: CapturedEmail[];
  clock?: Clock;
  turnstileVerifyUrl?: string;
  limits?: (scope: WorkspaceScope) => Promise<PlanLimits>;
}) {
  const db = createDb(options.pool);
  const onCreated: Array<(id: string) => Promise<void>> = [];
  const auth = createAuthService({
    db,
    baseURL: "http://localhost:4000",
    secret: "test-secret-".padEnd(40, "x"),
    webOrigin: WEB_ORIGIN,
    requestEmail: async (template, to, data) => {
      options.emails.push({ template, to, data });
    },
    rateLimit: false,
    onWorkspaceCreated: async (id) => {
      for (const hook of onCreated) await hook(id);
    },
    ...(options.turnstileVerifyUrl
      ? { turnstile: { secretKey: "test", siteVerifyURLOverride: options.turnstileVerifyUrl } }
      : {}),
  });
  const clock = options.clock ?? systemClock;
  const outbox = createOutbox();
  const cipher = createTokenCipher({ activeKeyId: "test", keys: { test: parseKey(TEST_KEY) } });
  const workspaces = createWorkspacesModule({ infra: { db, clock, auth, outbox } });
  if (workspaces.hooks?.onWorkspaceCreated) onCreated.push(workspaces.hooks.onWorkspaceCreated);
  const monitors = createMonitorsModule({
    infra: { db, clock, outbox, cipher },
    guards: workspaces.guards,
    ...(options.limits ? { limits: options.limits } : {}),
  });

  const app = createApp({
    config: { webOrigin: WEB_ORIGIN, api: { port: 0, trustProxy: "loopback" } },
    logger: pino({ level: "silent" }),
    redis: options.redis,
    readinessChecks: {},
    rawBodyRouters: [{ path: "/", router: auth.router }],
    routers: [...(workspaces.routers ?? []), ...(monitors.routers ?? [])],
    ipRateLimit: { windowMs: 60_000, limit: 10_000 },
  });
  return { app, db, auth, workspaces, monitors, cipher };
}

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

export const uniqueEmail = (who: string) => `${who}-${randomBytes(4).toString("hex")}@example.com`;

export function lastEmail(emails: CapturedEmail[], template: string, to: string): CapturedEmail {
  const found = emails.filter((e) => e.template === template && e.to === to).at(-1);
  if (found === undefined) throw new Error(`no ${template} email to ${to}`);
  return found;
}

/* Turns an emailed absolute link into a path the test app can request. */
export const pathOf = (url: unknown) => {
  const u = new URL(String(url));
  return `${u.pathname}${u.search}`;
};

export const post = (agent: TestAgent, path: string, body: object) =>
  agent.post(path).set("Origin", WEB_ORIGIN).send(body);
export const patch = (agent: TestAgent, path: string, body: object) =>
  agent.patch(path).set("Origin", WEB_ORIGIN).send(body);
export const get = (agent: TestAgent, path: string) => agent.get(path).set("Origin", WEB_ORIGIN);

export async function signUpAndVerify(
  agent: TestAgent,
  emails: CapturedEmail[],
  email: string,
  name: string,
): Promise<void> {
  const signUp = await post(agent, "/api/auth/sign-up/email", { email, password: PASSWORD, name });
  expect(signUp.status, signUp.text).toBe(200);
  const verify = await get(agent, pathOf(lastEmail(emails, "verify-email", email).data.url));
  expect([200, 302]).toContain(verify.status);
  const session = await get(agent, "/api/auth/get-session");
  expect(session.body?.user?.emailVerified).toBe(true);
}

export async function createWorkspace(agent: TestAgent, name: string): Promise<string> {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomBytes(4).toString("hex")}`;
  const created = await post(agent, "/api/auth/organization/create", { name, slug });
  expect(created.status, created.text).toBe(200);
  return created.body.id as string;
}

export async function inviteAndAccept(
  owner: TestAgent,
  invitee: TestAgent,
  emails: CapturedEmail[],
  workspaceId: string,
  inviteeEmail: string,
  role: "admin" | "member" | "viewer",
): Promise<void> {
  const invite = await post(owner, "/api/auth/organization/invite-member", {
    email: inviteeEmail,
    role,
    organizationId: workspaceId,
  });
  expect(invite.status, invite.text).toBe(200);
  const invitationId = String(lastEmail(emails, "invite", inviteeEmail).data.url)
    .split("/")
    .at(-1);
  const accept = await post(invitee, "/api/auth/organization/accept-invitation", { invitationId });
  expect(accept.status, accept.text).toBe(200);
}

export { request };
