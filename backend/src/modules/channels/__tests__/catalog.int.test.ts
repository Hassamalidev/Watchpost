/*
 * P1-T29 through the real API with providers mocked at the HTTP layer: which channel types this
 * server offers, creating the new types from the catalog's fields, write-only secrets (masked in
 * every answer, kept on update, never in the database in clear text), per-channel rules, and
 * "Send test" reaching each provider.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { CHANNEL_TYPES, SECRET_MASK } from "@app/shared";
import {
  WEB_ORIGIN,
  buildContainerApp,
  emailFromOutbox,
  signUpVerified,
  stubHttp,
} from "../../../__tests__/helpers/container-app.js";

const http = stubHttp((req) => {
  if (req.url.includes("pagerduty.com")) return { status: 202, body: '{"status":"success"}' };
  if (req.url.includes("api.pushover.net")) return { body: '{"status":1,"request":"r"}' };
  if (req.url.includes("ntfy.example.com")) return { status: 403, body: '{"error":"forbidden"}' };
  return undefined;
});

let ctx: ReturnType<typeof buildContainerApp>;
let owner: TestAgent;
let viewer: TestAgent;
let ws: string;

const send = (agent: TestAgent, method: "post" | "patch", path: string, body?: object) =>
  agent[method](path).set("Origin", WEB_ORIGIN).send(body);
const get = (agent: TestAgent, path: string) => agent.get(path).set("Origin", WEB_ORIGIN);
const unique = (who: string) => `${who}-${randomBytes(4).toString("hex")}@example.com`;

beforeAll(async () => {
  ctx = buildContainerApp({ authRateLimit: false, http });
  owner = request.agent(ctx.app);
  viewer = request.agent(ctx.app);
  await signUpVerified(ctx, owner, unique("cat-owner"));
  const created = await send(owner, "post", "/api/auth/organization/create", {
    name: "Catalog Co",
    slug: `catalog-co-${randomBytes(4).toString("hex")}`,
  });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id;

  const viewerEmail = unique("cat-viewer");
  await signUpVerified(ctx, viewer, viewerEmail);
  await send(owner, "post", "/api/auth/organization/invite-member", {
    email: viewerEmail,
    role: "viewer",
    organizationId: ws,
  });
  const { url } = await emailFromOutbox(ctx.container, viewerEmail, "invite");
  await send(viewer, "post", "/api/auth/organization/accept-invitation", {
    invitationId: String(url).split("/").at(-1),
  });
});

afterAll(async () => {
  await ctx.container.close();
});

describe("channel types", () => {
  it("lists every type; the Slack app, Telegram, SMS and voice need server credentials", async () => {
    const res = await get(viewer, `/api/w/${ws}/channels/types`);
    expect(res.status, res.text).toBe(200);
    const available = new Map(
      (res.body.data as Array<{ type: string; available: boolean }>).map((t) => [
        t.type,
        t.available,
      ]),
    );
    expect([...available.keys()]).toEqual([...CHANNEL_TYPES]);
    expect(available.get("slack")).toBe(false);
    expect(available.get("telegram")).toBe(false);
    /* SMS and voice need a messaging provider on the server. */
    const needServer = ["slack", "telegram", "sms", "voice"];
    expect(available.get("sms")).toBe(false);
    expect(available.get("voice")).toBe(false);
    for (const type of CHANNEL_TYPES.filter((t) => !needServer.includes(t))) {
      expect(available.get(type), type).toBe(true);
    }
  });
});

describe("a channel with secrets (PagerDuty)", () => {
  const routingKey = "R0UT1NGKEY".padEnd(32, "x");
  let id: string;

  it("is created with rules, answers with the key masked and stores it encrypted", async () => {
    const res = await send(owner, "post", `/api/w/${ws}/channels`, {
      type: "pagerduty",
      name: "Primary on-call",
      config: { routingKey, region: "eu" },
      rules: { minSeverity: "high", events: { reminder: false } },
    });
    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({
      type: "pagerduty",
      config: { routingKey: SECRET_MASK, region: "eu" },
      rules: { minSeverity: "high", events: { triggered: true, reminder: false } },
    });
    expect(res.text).not.toContain(routingKey);
    id = res.body.id;

    const [row] = (
      await ctx.container.infra.db.execute<{ config_enc: string; rules: unknown }>(
        sql`select config_enc, rules from channels where id = ${id}`,
      )
    ).rows;
    expect(row?.config_enc).not.toContain(routingKey);
    expect(row?.rules).toMatchObject({ minSeverity: "high" });
  });

  it("names the field when the key is malformed", async () => {
    const res = await send(owner, "post", `/api/w/${ws}/channels`, {
      type: "pagerduty",
      name: "Broken",
      config: { routingKey: "nope" },
    });
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual([
      {
        path: "body.config.routingKey",
        message: "must be the 32-character integration key",
      },
    ]);
    expect(res.body.detail).toBe("PagerDuty: routingKey must be the 32-character integration key");
  });

  it("everyone sees the rules; only admins see the (masked) config", async () => {
    const list = await get(viewer, `/api/w/${ws}/channels`);
    const mine = (list.body.data as Array<Record<string, unknown>>).find((c) => c.id === id);
    expect(mine).toMatchObject({ name: "Primary on-call", rules: { minSeverity: "high" } });
    expect(mine?.config).toBeUndefined();
    expect((await get(viewer, `/api/w/${ws}/channels/${id}`)).status).toBe(403);
    const detail = await get(owner, `/api/w/${ws}/channels/${id}`);
    expect(detail.body.config.routingKey).toBe(SECRET_MASK);
  });

  it("keeps the key when the form sends the mask back, and changes rules on their own", async () => {
    const edited = await send(owner, "patch", `/api/w/${ws}/channels/${id}`, {
      name: "Primary pager",
      config: { routingKey: SECRET_MASK, region: "us" },
    });
    expect(edited.status, edited.text).toBe(200);
    expect(edited.body).toMatchObject({ name: "Primary pager", config: { region: "us" } });

    const rules = await send(owner, "patch", `/api/w/${ws}/channels/${id}`, {
      rules: { minSeverity: "critical" },
    });
    expect(rules.status, rules.text).toBe(200);
    /* Only what was sent changes: reminders stay off. */
    expect(rules.body.rules).toMatchObject({
      minSeverity: "critical",
      events: { triggered: true, reminder: false },
    });
    const events = await send(owner, "patch", `/api/w/${ws}/channels/${id}`, {
      rules: { events: { flapping: false } },
    });
    expect(events.body.rules).toMatchObject({
      minSeverity: "critical",
      events: { reminder: false, flapping: false, resolved: true },
    });
    expect((await send(owner, "patch", `/api/w/${ws}/channels/${id}`, {})).status).toBe(400);
    expect(
      (
        await send(owner, "patch", `/api/w/${ws}/channels/${id}`, {
          rules: { minSeverity: "sometimes" },
        })
      ).status,
    ).toBe(400);
  });

  it("Send test opens and resolves a test alert with the stored key", async () => {
    const test = await send(owner, "post", `/api/w/${ws}/channels/${id}/test`);
    expect(test.body).toEqual({ ok: true });
    const calls = http.requests.filter((r) => r.url.includes("pagerduty.com")).slice(-2);
    expect(calls.map((r) => r.url)).toEqual([
      "https://events.pagerduty.com/v2/enqueue",
      "https://events.pagerduty.com/v2/enqueue",
    ]);
    const [trigger, resolve] = calls.map((r) => JSON.parse(r.body ?? "{}"));
    expect(trigger).toMatchObject({ routing_key: routingKey, event_action: "trigger" });
    expect(resolve).toMatchObject({ event_action: "resolve", dedup_key: trigger.dedup_key });
  });
});

describe("creating from catalog forms", () => {
  it("applies defaults, ignores empty optional fields and reports provider errors on test", async () => {
    const ntfy = await send(owner, "post", `/api/w/${ws}/channels`, {
      type: "ntfy",
      name: "Phone",
      config: { serverUrl: "https://ntfy.example.com", topic: "acme-ops", accessToken: "" },
    });
    expect(ntfy.status, ntfy.text).toBe(201);
    expect(ntfy.body.config).toEqual({ serverUrl: "https://ntfy.example.com", topic: "acme-ops" });
    const failed = await send(owner, "post", `/api/w/${ws}/channels/${ntfy.body.id}/test`);
    expect(failed.body).toEqual({ ok: false, error: "ntfy refused the message: forbidden" });
    const list = await get(owner, `/api/w/${ws}/channels`);
    const row = (list.body.data as Array<Record<string, unknown>>).find(
      (c) => c.id === ntfy.body.id,
    );
    expect(row?.lastError).toBe("ntfy refused the message: forbidden");

    const pushover = await send(owner, "post", `/api/w/${ws}/channels`, {
      type: "pushover",
      name: "Pushover",
      config: { userKey: "u".repeat(30), appToken: "a".repeat(30) },
    });
    expect(pushover.status, pushover.text).toBe(201);
    expect(pushover.body.config).toEqual({
      userKey: SECRET_MASK,
      appToken: SECRET_MASK,
      critical: "high",
    });
    expect(
      (await send(owner, "post", `/api/w/${ws}/channels/${pushover.body.id}/test`)).body,
    ).toEqual({ ok: true });
  });

  it("secret URLs show only where they point", async () => {
    const slack = await send(owner, "post", `/api/w/${ws}/channels`, {
      type: "slack_webhook",
      name: "Slack #ops",
      config: { url: "https://hooks.slack.com/services/T0AAA/B0BBB/secretPart" },
    });
    expect(slack.status, slack.text).toBe(201);
    expect(slack.body.config).toEqual({ url: `https://hooks.slack.com/${SECRET_MASK}` });
    const renamed = await send(owner, "patch", `/api/w/${ws}/channels/${slack.body.id}`, {
      name: "Slack #incidents",
      config: { url: "" },
    });
    expect(renamed.status, renamed.text).toBe(200);
    expect((await send(owner, "post", `/api/w/${ws}/channels/${slack.body.id}/test`)).body).toEqual(
      { ok: true },
    );
    expect(http.requests.at(-1)?.url).toBe(
      "https://hooks.slack.com/services/T0AAA/B0BBB/secretPart",
    );
  });

  it("a wrong URL for the integration says what was expected", async () => {
    const res = await send(owner, "post", `/api/w/${ws}/channels`, {
      type: "google_chat",
      name: "Chat",
      config: { url: "https://hooks.slack.com/services/T0AAA/B0BBB/abc" },
    });
    expect(res.status).toBe(400);
    expect(res.body.errors[0]).toMatchObject({ path: "body.config.url" });
    expect(res.body.errors[0].message).toContain("must be a Google Chat webhook URL");
  });
});
