/*
 * P1-T01 AC, end to end against real Postgres: sign up → verify → create workspace → invite →
 * accept, plus role checks, TOTP 2FA, magic links and Turnstile on sign-up.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { createDbPool, type DbPool } from "../../../infra/db/index.js";
import { createRedis, type RedisClient } from "../../../infra/redis.js";
import { TEST_DATABASE_URL, TEST_REDIS_URL } from "../../../__tests__/helpers/test-env.js";
import { secretFromOtpauthUri, totp } from "../../../__tests__/helpers/totp.js";
import {
  PASSWORD,
  WEB_ORIGIN,
  buildWorkspaceTestApp,
  get,
  lastEmail as lastEmailIn,
  pathOf,
  post,
  signUpAndVerify as signUpAndVerifyIn,
  type CapturedEmail,
} from "../../../__tests__/helpers/workspace-app.js";

const run = randomBytes(4).toString("hex");
const emailFor = (who: string) => `${who}-${run}@example.com`;

let pool: DbPool;
let redis: RedisClient;
const emails: CapturedEmail[] = [];

function buildApp(options: { turnstileVerifyUrl?: string } = {}) {
  return buildWorkspaceTestApp({ pool, redis, emails, ...options }).app;
}

const lastEmail = (template: string, to: string) => lastEmailIn(emails, template, to);
const signUpAndVerify = (agent: TestAgent, email: string, name: string) =>
  signUpAndVerifyIn(agent, emails, email, name);

beforeAll(() => {
  pool = createDbPool(TEST_DATABASE_URL, { max: 5 });
  redis = createRedis(TEST_REDIS_URL);
});

afterAll(async () => {
  await pool.end();
  await redis.quit();
});

describe("sign up → verify → workspace → invite → accept", () => {
  const app = () => buildApp();
  let appInstance: ReturnType<typeof buildApp>;
  let owner: TestAgent;
  let memberAgent: TestAgent;
  let workspaceId: string;

  beforeAll(() => {
    appInstance = app();
    owner = request.agent(appInstance);
    memberAgent = request.agent(appInstance);
  });

  it("blocks sign-in until the email is verified", async () => {
    const email = emailFor("owner");
    const signUp = await post(owner, "/api/auth/sign-up/email", {
      email,
      password: PASSWORD,
      name: "Owner",
    });
    expect(signUp.status, signUp.text).toBe(200);
    expect(lastEmail("verify-email", email).data.url).toMatch(/verify-email\?token=/);

    const signIn = await post(request.agent(appInstance), "/api/auth/sign-in/email", {
      email,
      password: PASSWORD,
    });
    expect(signIn.status).toBe(403);
  });

  it("verifies the email from the link and signs the user in", async () => {
    const email = emailFor("owner");
    const verify = await get(owner, pathOf(lastEmail("verify-email", email).data.url));
    expect([200, 302]).toContain(verify.status);
    const session = await get(owner, "/api/auth/get-session");
    expect(session.body.user).toMatchObject({ email, emailVerified: true });
    expect(session.body.user.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("creates a workspace; the creator is its owner", async () => {
    const created = await post(owner, "/api/auth/organization/create", {
      name: "Acme",
      slug: `acme-${run}`,
    });
    expect(created.status, created.text).toBe(200);
    workspaceId = created.body.id;
    expect(workspaceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);

    const me = await get(owner, `/api/w/${workspaceId}/me`);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ workspaceId, role: "owner", email: emailFor("owner") });
  });

  it("invites a member by email", async () => {
    const invite = await post(owner, "/api/auth/organization/invite-member", {
      email: emailFor("member"),
      role: "member",
      organizationId: workspaceId,
    });
    expect(invite.status, invite.text).toBe(200);
    const email = lastEmail("invite", emailFor("member"));
    expect(email.data).toMatchObject({ workspaceName: "Acme", role: "member" });
    expect(String(email.data.url)).toMatch(new RegExp(`^${WEB_ORIGIN}/invite/[0-9a-f-]{36}$`));
  });

  it("the invitee signs up, verifies and accepts", async () => {
    await signUpAndVerify(memberAgent, emailFor("member"), "Member");
    const invitationId = String(lastEmail("invite", emailFor("member")).data.url)
      .split("/")
      .at(-1);
    const accept = await post(memberAgent, "/api/auth/organization/accept-invitation", {
      invitationId,
    });
    expect(accept.status, accept.text).toBe(200);

    const me = await get(memberAgent, `/api/w/${workspaceId}/me`);
    expect(me.status).toBe(200);
    expect(me.body.role).toBe("member");
  });

  it("enforces roles: admin-only routes, Better Auth permissions, outsiders and anonymous users", async () => {
    const asMember = await get(memberAgent, `/api/w/${workspaceId}/members`);
    expect(asMember.status).toBe(403);
    expect(asMember.body.code ?? JSON.parse(asMember.text).code).toBe("forbidden");

    const asOwner = await get(owner, `/api/w/${workspaceId}/members`);
    expect(asOwner.status).toBe(200);
    expect(asOwner.body.data.map((m: { role: string }) => m.role).sort()).toEqual([
      "member",
      "owner",
    ]);

    const memberInvites = await post(memberAgent, "/api/auth/organization/invite-member", {
      email: emailFor("sneaky"),
      role: "admin",
      organizationId: workspaceId,
    });
    expect(memberInvites.status).toBe(403);

    const outsider = request.agent(appInstance);
    await signUpAndVerify(outsider, emailFor("outsider"), "Outsider");
    expect((await get(outsider, `/api/w/${workspaceId}/me`)).status).toBe(404);
    expect((await get(outsider, "/api/w/not-a-uuid/me")).status).toBe(404);

    const anonymous = await request(appInstance).get(`/api/w/${workspaceId}/me`);
    expect(anonymous.status).toBe(401);
  });
});

describe("two-factor authentication (TOTP)", () => {
  it("requires a TOTP code at sign-in once enabled", async () => {
    const appInstance = buildApp();
    const user = request.agent(appInstance);
    const email = emailFor("twofa");
    await signUpAndVerify(user, email, "Two Factor");

    const enable = await post(user, "/api/auth/two-factor/enable", { password: PASSWORD });
    expect(enable.status, enable.text).toBe(200);
    const secret = secretFromOtpauthUri(enable.body.totpURI);
    const confirm = await post(user, "/api/auth/two-factor/verify-totp", { code: totp(secret) });
    expect(confirm.status, confirm.text).toBe(200);

    const fresh = request.agent(appInstance);
    const signIn = await post(fresh, "/api/auth/sign-in/email", { email, password: PASSWORD });
    expect(signIn.status).toBe(200);
    expect(signIn.body.twoFactorRedirect).toBe(true);
    expect((await get(fresh, "/api/auth/get-session")).body).toBeNull();

    const wrong = await post(fresh, "/api/auth/two-factor/verify-totp", { code: "000000" });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    const right = await post(fresh, "/api/auth/two-factor/verify-totp", { code: totp(secret) });
    expect(right.status, right.text).toBe(200);
    expect((await get(fresh, "/api/auth/get-session")).body.user.email).toBe(email);
  });
});

describe("magic link", () => {
  it("signs a verified user in from the emailed link", async () => {
    const appInstance = buildApp();
    const email = emailFor("magic");
    await signUpAndVerify(request.agent(appInstance), email, "Magic");

    const agent = request.agent(appInstance);
    const ask = await post(agent, "/api/auth/sign-in/magic-link", { email, callbackURL: "/" });
    expect(ask.status, ask.text).toBe(200);
    const follow = await get(agent, pathOf(lastEmail("magic-link", email).data.url));
    expect([200, 302]).toContain(follow.status);
    expect((await get(agent, "/api/auth/get-session")).body.user.email).toBe(email);
  });
});

describe("Turnstile on sign-up", () => {
  let stub: http.Server;
  let verifyUrl: string;
  const verified: string[] = [];

  beforeAll(async () => {
    stub = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const token =
          new URLSearchParams(body).get("response") ?? JSON.parse(body || "{}").response;
        verified.push(String(token));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ success: token === "good-token" }));
      });
    });
    stub.listen(0, "127.0.0.1");
    await once(stub, "listening");
    const address = stub.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    verifyUrl = `http://127.0.0.1:${address.port}/siteverify`;
  });

  afterAll(async () => {
    await new Promise((r) => stub.close(r));
  });

  it("rejects sign-up without a valid token and accepts a valid one", async () => {
    const appInstance = buildApp({ turnstileVerifyUrl: verifyUrl });
    const body = { email: emailFor("captcha"), password: PASSWORD, name: "Captcha" };

    const missing = await post(request.agent(appInstance), "/api/auth/sign-up/email", body);
    expect(missing.status).toBeGreaterThanOrEqual(400);

    const bad = await request
      .agent(appInstance)
      .post("/api/auth/sign-up/email")
      .set("Origin", WEB_ORIGIN)
      .set("x-captcha-response", "bad-token")
      .send(body);
    expect(bad.status).toBeGreaterThanOrEqual(400);

    const good = await request
      .agent(appInstance)
      .post("/api/auth/sign-up/email")
      .set("Origin", WEB_ORIGIN)
      .set("x-captcha-response", "good-token")
      .send(body);
    expect(good.status, good.text).toBe(200);
    expect(verified).toContain("good-token");
  });
});
