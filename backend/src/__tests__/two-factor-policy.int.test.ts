/*
 * P7-T02b through the real app: a workspace on Business can require two-factor sign-in. A member
 * without it gets nothing from that workspace except the answer that tells the app to show the
 * set-up screen, and gets in as soon as they have set it up. Two-factor is set up through the auth
 * library's own endpoints, with real TOTP codes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { newId } from "../infra/ids.js";
import {
  PASSWORD,
  WEB_ORIGIN,
  buildContainerApp,
  emailFromOutbox,
  signUpVerified,
} from "./helpers/container-app.js";

const ctx = buildContainerApp({ authRateLimit: false });
const run = randomBytes(4).toString("hex");
const memberEmail = `tfa-member-${run}@example.com`;
let owner: TestAgent;
let member: TestAgent;
let ws = "";

const api = (agent: TestAgent, method: "get" | "patch", path: string) =>
  agent[method](`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN);
const auth = (agent: TestAgent, path: string, body: object) =>
  agent.post(`/api/auth/${path}`).set("Origin", WEB_ORIGIN).send(body);

/* RFC 6238 with the defaults every authenticator app uses: SHA-1, 30 seconds, six digits. */
function totp(secretBase32: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secretBase32.replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  }
  const key = Buffer.from(bits.match(/.{8}/g)?.map((byte) => Number.parseInt(byte, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/* Sets up two-factor sign-in the way the app does: ask for a secret, then prove a code from it. */
async function enableTwoFactor(agent: TestAgent): Promise<string[]> {
  const enabled = await auth(agent, "two-factor/enable", { password: PASSWORD });
  expect(enabled.status, enabled.text).toBe(200);
  const secret = new URL(enabled.body.totpURI as string).searchParams.get("secret") ?? "";
  const verified = await auth(agent, "two-factor/verify-totp", { code: totp(secret) });
  expect(verified.status, verified.text).toBe(200);
  return enabled.body.backupCodes as string[];
}

beforeAll(async () => {
  owner = request.agent(ctx.app);
  member = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `tfa-${run}@example.com`);
  const created = await auth(owner, "organization/create", {
    name: "TFA Co",
    slug: `tfa-${run}`,
  });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id as string;
  await signUpVerified(ctx, member, memberEmail);
  await auth(owner, "organization/invite-member", {
    email: memberEmail,
    role: "member",
    organizationId: ws,
  });
  const { url } = await emailFromOutbox(ctx.container, memberEmail, "invite");
  await auth(member, "organization/accept-invitation", {
    invitationId: String(url).split("/").at(-1),
  });
}, 120_000);

afterAll(async () => {
  await ctx.container.close();
});

describe("required two-factor sign-in", () => {
  it("is part of Business, and whoever requires it has to have it", async () => {
    expect((await api(owner, "get", "/settings")).body.requireTwoFactor).toBe(false);
    const onTrial = await api(owner, "patch", "/settings").send({ requireTwoFactor: true });
    expect(onTrial.status).toBe(402);
    expect(onTrial.body.detail).toContain("Business plan");

    const start = new Date(Date.now() - 86_400_000).toISOString();
    const end = new Date(Date.now() + 29 * 86_400_000).toISOString();
    await ctx.container.infra.db.execute(sql`
      insert into subscriptions (id, workspace_id, paddle_subscription_id, paddle_customer_id, status,
        plan_key, billing_interval, items, period_start, period_end, paid_period_start, paid_period_end,
        last_event_at)
      values (${newId()}, ${ws}, ${`sub_${run}`}, ${`ctm_${run}`}, 'active', 'business', 'month',
        '[]'::jsonb, ${start}::timestamptz, ${end}::timestamptz, ${start}::timestamptz, ${end}::timestamptz,
        ${start}::timestamptz)`);

    const withoutOwn = await api(owner, "patch", "/settings").send({ requireTwoFactor: true });
    expect(withoutOwn.status).toBe(409);
    expect(withoutOwn.body.detail).toContain("your own account first");

    const backupCodes = await enableTwoFactor(owner);
    expect(backupCodes.length).toBeGreaterThanOrEqual(8);
    expect((await api(owner, "get", "/me")).body).toMatchObject({
      twoFactorEnabled: true,
      twoFactorRequired: false,
    });
    const required = await api(owner, "patch", "/settings").send({ requireTwoFactor: true });
    expect(required.status, required.text).toBe(200);
    expect(required.body.requireTwoFactor).toBe(true);
  });

  it("locks a member without it out of everything but the question that explains why", async () => {
    const refused = await api(member, "get", "/monitors");
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toContain("requires two-factor sign-in");
    expect((await api(member, "get", "/settings")).status).toBe(403);
    const me = await api(member, "get", "/me");
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      role: "member",
      twoFactorEnabled: false,
      twoFactorRequired: true,
    });
    /* The owner, who has it, is not affected. */
    expect((await api(owner, "get", "/monitors")).status).toBe(200);
  });

  it("lets the member in once they have set it up", async () => {
    await enableTwoFactor(member);
    expect((await api(member, "get", "/monitors")).status).toBe(200);
    expect((await api(member, "get", "/me")).body).toMatchObject({
      twoFactorEnabled: true,
      twoFactorRequired: false,
    });
  });

  it("asks for the code at the next sign-in; the password alone opens nothing", async () => {
    const fresh = request.agent(ctx.app);
    const signedIn = await auth(fresh, "sign-in/email", { email: memberEmail, password: PASSWORD });
    expect(signedIn.status, signedIn.text).toBe(200);
    expect(signedIn.body.twoFactorRedirect).toBe(true);
    /* The password alone opens nothing. */
    expect((await api(fresh, "get", "/me")).status).toBe(401);
    expect((await auth(fresh, "two-factor/verify-totp", { code: "000000" })).status).toBe(401);
    const stored = await ctx.container.infra.db.execute<{ secret: string }>(
      sql`select 1 as secret from two_factor tf join "user" u on u.id = tf.user_id where u.email = ${memberEmail}`,
    );
    expect(stored.rows).toHaveLength(1);
  });

  it("can be switched off again, and the setting changes are in the audit log", async () => {
    const off = await api(owner, "patch", "/settings").send({ requireTwoFactor: false });
    expect(off.body.requireTwoFactor).toBe(false);
    let actions: string[] = [];
    for (let attempt = 0; attempt < 50 && actions.length < 2; attempt += 1) {
      actions = (
        await ctx.container.infra.db.execute<{ action: string }>(
          sql`select action from audit_logs where workspace_id = ${ws} and action = 'settings.update'`,
        )
      ).rows.map((r) => r.action);
      if (actions.length < 2) await new Promise((resolve) => setTimeout(resolve, 40));
    }
    expect(actions).toEqual(["settings.update", "settings.update"]);
  });
});
