/*
 * Slack install, Telegram linking and "Send test" through the real API, with Slack and Telegram
 * mocked at the HTTP layer: the OAuth state is bound to the user and workspace, the bot token is
 * stored encrypted, channels can only use their own workspace's installation, the Telegram webhook
 * needs the secret and links the chat that opened the deep link once.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  signUpVerified,
  stubHttp,
} from "../../../__tests__/helpers/container-app.js";

const TELEGRAM_SECRET = "telegram-secret-0123456789";
const slackFails = { post: false };
const http = stubHttp((req) => {
  if (req.url.endsWith("/oauth.v2.access")) {
    return {
      body: JSON.stringify({
        ok: true,
        access_token: "xoxb-secret-token",
        scope: "chat:write,channels:read",
        bot_user_id: "U0BOT",
        team: { id: "T0ACME", name: "Acme Slack" },
      }),
    };
  }
  if (req.url.endsWith("/conversations.list")) {
    return {
      body: JSON.stringify({
        ok: true,
        channels: [
          { id: "C0ZED", name: "zed", is_private: false },
          { id: "G0OPS", name: "ops", is_private: true },
        ],
        response_metadata: { next_cursor: "" },
      }),
    };
  }
  if (req.url.endsWith("/chat.postMessage")) {
    return slackFails.post
      ? { body: '{"ok":false,"error":"channel_not_found"}' }
      : { body: '{"ok":true,"ts":"1700000000.000200"}' };
  }
  if (req.url.includes("api.telegram.org")) {
    return { body: '{"ok":true,"result":{"message_id":7}}' };
  }
  return undefined;
});

let ctx: ReturnType<typeof buildContainerApp>;
let owner: TestAgent;
let other: TestAgent;
let ws: string;
let otherWs: string;

const send = (agent: TestAgent, method: "post" | "get", path: string, body?: object) =>
  method === "get"
    ? agent.get(path).set("Origin", WEB_ORIGIN)
    : agent.post(path).set("Origin", WEB_ORIGIN).send(body);

async function workspace(agent: TestAgent, name: string) {
  const res = await send(agent, "post", "/api/auth/organization/create", {
    name,
    slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomBytes(4).toString("hex")}`,
  });
  expect(res.status, res.text).toBe(200);
  return res.body.id as string;
}

async function installSlack(agent: TestAgent, workspaceId: string) {
  const start = await send(agent, "get", `/api/w/${workspaceId}/integrations/slack/install`);
  expect(start.status, start.text).toBe(200);
  const state = new URL(start.body.url).searchParams.get("state") ?? "";
  return { url: new URL(start.body.url), state };
}

beforeAll(async () => {
  ctx = buildContainerApp({
    authRateLimit: false,
    http,
    env: {
      SLACK_CLIENT_ID: "111.222",
      SLACK_CLIENT_SECRET: "slack-client-secret",
      TELEGRAM_BOT_TOKEN: "123456:ABC-def",
      TELEGRAM_BOT_USERNAME: "WatchpostTestBot",
      TELEGRAM_WEBHOOK_SECRET: TELEGRAM_SECRET,
    },
  });
  owner = request.agent(ctx.app);
  other = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `int-owner-${randomBytes(4).toString("hex")}@example.com`);
  ws = await workspace(owner, "Integrations Co");
  await signUpVerified(ctx, other, `int-other-${randomBytes(4).toString("hex")}@example.com`);
  otherWs = await workspace(other, "Other Co");
});

afterAll(async () => {
  await ctx.container.close();
});

describe("Slack", () => {
  let installationId: string;

  it("starts the OAuth install with the app's scopes and a signed state", async () => {
    const { url, state } = await installSlack(owner, ws);
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe("111.222");
    expect(url.searchParams.get("scope")).toContain("chat:write");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:4000/api/integrations/slack/callback",
    );
    expect(state.length).toBeGreaterThan(40);
  });

  it("refuses a tampered state or another user's install", async () => {
    const { state } = await installSlack(owner, ws);
    const tampered = await send(
      owner,
      "get",
      `/api/integrations/slack/callback?code=abc&state=${encodeURIComponent(`${state}x`)}`,
    );
    expect(tampered.status).toBe(400);
    const stolen = await send(
      other,
      "get",
      `/api/integrations/slack/callback?code=abc&state=${encodeURIComponent(state)}`,
    );
    expect(stolen.status).toBe(403);
    const cancelled = await send(
      owner,
      "get",
      "/api/integrations/slack/callback?error=access_denied",
    );
    expect(cancelled.status).toBe(303);
    expect(cancelled.headers.location).toBe(`${WEB_ORIGIN}/?slack=cancelled`);
  });

  it("stores the installation with the bot token encrypted and lists the team's channels", async () => {
    const { state } = await installSlack(owner, ws);
    const done = await send(
      owner,
      "get",
      `/api/integrations/slack/callback?code=abc&state=${encodeURIComponent(state)}`,
    );
    expect(done.status, done.text).toBe(303);
    expect(done.headers.location).toBe(`${WEB_ORIGIN}/w/${ws}/integrations?slack=installed`);
    const exchange = http.requests.find((r) => r.url.endsWith("/oauth.v2.access"));
    expect(exchange?.body).toContain("client_secret=slack-client-secret");
    expect(exchange?.body).toContain("code=abc");

    const list = await send(owner, "get", `/api/w/${ws}/integrations/slack/installations`);
    expect(list.body.data).toEqual([
      expect.objectContaining({ teamId: "T0ACME", teamName: "Acme Slack" }),
    ]);
    installationId = list.body.data[0].id;
    const [row] = (
      await ctx.container.infra.db.execute<{ bot_token_enc: string }>(
        sql`select bot_token_enc from slack_installations where id = ${installationId}`,
      )
    ).rows;
    expect(row?.bot_token_enc).not.toContain("xoxb-secret-token");

    const channels = await send(
      owner,
      "get",
      `/api/w/${ws}/integrations/slack/installations/${installationId}/channels`,
    );
    expect(channels.body.data).toEqual([
      { id: "G0OPS", name: "ops", isPrivate: true },
      { id: "C0ZED", name: "zed", isPrivate: false },
    ]);
    const listCall = http.requests.find((r) => r.url.endsWith("/conversations.list"));
    expect(listCall?.headers?.authorization).toBe("Bearer xoxb-secret-token");
  });

  it("creates Slack channels only from this workspace's installation, and sends tests", async () => {
    const foreign = await send(other, "post", `/api/w/${otherWs}/channels`, {
      type: "slack",
      name: "Stolen",
      config: { installationId, channelId: "C0ZED", channelName: "zed" },
    });
    expect(foreign.status).toBe(400);
    expect(
      (
        await send(
          other,
          "get",
          `/api/w/${otherWs}/integrations/slack/installations/${installationId}/channels`,
        )
      ).status,
    ).toBe(404);

    const created = await send(owner, "post", `/api/w/${ws}/channels`, {
      type: "slack",
      name: "Slack #zed",
      config: { installationId, channelId: "C0ZED", channelName: "zed" },
    });
    expect(created.status, created.text).toBe(201);

    const test = await send(owner, "post", `/api/w/${ws}/channels/${created.body.id}/test`);
    expect(test.body).toEqual({ ok: true });
    const post = http.requests.filter((r) => r.url.endsWith("/chat.postMessage")).at(-1);
    expect(JSON.parse(post?.body ?? "{}")).toMatchObject({
      channel: "C0ZED",
      text: "Test alert from Watchpost",
    });

    slackFails.post = true;
    const failed = await send(owner, "post", `/api/w/${ws}/channels/${created.body.id}/test`);
    expect(failed.body).toEqual({
      ok: false,
      error: "Slack refused the message: channel_not_found",
    });
    slackFails.post = false;
  });
});

describe("Telegram", () => {
  let channelId: string;
  let token: string;
  const update = (text: string, chatId = -100777) => ({
    update_id: 1,
    message: { message_id: 1, text, chat: { id: chatId, type: "group", title: "Ops room" } },
  });
  const webhook = (body: object, secret = TELEGRAM_SECRET) =>
    request(ctx.app)
      .post("/api/webhooks/telegram")
      .set("x-telegram-bot-api-secret-token", secret)
      .send(body);

  it("creates an unlinked channel and a one-day deep link", async () => {
    const created = await send(owner, "post", `/api/w/${ws}/channels`, {
      type: "telegram",
      name: "Ops Telegram",
      config: { chatId: "12345" },
    });
    expect(created.status, created.text).toBe(201);
    expect(created.body.config).toEqual({ chatId: null, chatTitle: null });
    channelId = created.body.id;

    const link = await send(owner, "post", `/api/w/${ws}/channels/${channelId}/telegram-link`);
    expect(link.status, link.text).toBe(201);
    expect(link.body.url).toMatch(/^https:\/\/t\.me\/WatchpostTestBot\?start=[\w-]+$/);
    token = new URL(link.body.url).searchParams.get("start") ?? "";

    const test = await send(owner, "post", `/api/w/${ws}/channels/${channelId}/test`);
    expect(test.body.ok).toBe(false);
  });

  it("rejects webhook calls without the secret", async () => {
    expect((await webhook(update(`/start ${token}`), "wrong-secret-0000000000")).status).toBe(401);
    expect(
      (await request(ctx.app).post("/api/webhooks/telegram").send(update("/start x"))).status,
    ).toBe(401);
  });

  it("links the chat that opens the deep link, once", async () => {
    expect((await webhook(update(`/start ${token}`))).status).toBe(200);
    const detail = await send(owner, "get", `/api/w/${ws}/channels/${channelId}`);
    expect(detail.body.config).toEqual({ chatId: "-100777", chatTitle: "Ops room" });
    const reply = http.requests.filter((r) => r.url.endsWith("/sendMessage")).at(-1);
    expect(JSON.parse(reply?.body ?? "{}")).toMatchObject({ chat_id: "-100777" });
    expect(reply?.body).toContain("Linked");

    await webhook(update(`/start ${token}`, -100999));
    const again = await send(owner, "get", `/api/w/${ws}/channels/${channelId}`);
    expect(again.body.config.chatId).toBe("-100777");
    expect(http.requests.filter((r) => r.url.endsWith("/sendMessage")).at(-1)?.body).toContain(
      "expired",
    );
  });

  it("sends test alerts to the linked chat", async () => {
    const test = await send(owner, "post", `/api/w/${ws}/channels/${channelId}/test`);
    expect(test.body).toEqual({ ok: true });
    const sent = http.requests.filter((r) => r.url.endsWith("/sendMessage")).at(-1);
    expect(sent?.url).toBe("https://api.telegram.org/bot123456:ABC-def/sendMessage");
    expect(JSON.parse(sent?.body ?? "{}")).toMatchObject({ chat_id: "-100777" });
  });
});

describe("webhook, Discord and Teams channels", () => {
  it("create through the API and send tests", async () => {
    const hook = await send(owner, "post", `/api/w/${ws}/channels`, {
      type: "webhook",
      name: "Pager bridge",
      config: { url: "https://hooks.example.com/watchpost" },
    });
    expect(hook.status, hook.text).toBe(201);
    expect(hook.body.config.secret).toMatch(/^whsec_/);
    expect((await send(owner, "post", `/api/w/${ws}/channels/${hook.body.id}/test`)).body).toEqual({
      ok: true,
    });
    const sent = http.requests.at(-1);
    expect(sent?.url).toBe("https://hooks.example.com/watchpost");
    expect(sent?.headers?.["watchpost-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    const discord = await send(owner, "post", `/api/w/${ws}/channels`, {
      type: "discord",
      name: "Discord",
      config: { url: "https://discord.com/api/webhooks/1/abc" },
    });
    expect(discord.status, discord.text).toBe(201);
    const teams = await send(owner, "post", `/api/w/${ws}/channels`, {
      type: "teams",
      name: "Teams",
      config: { url: "https://prod-1.westus.logic.azure.com/workflows/x" },
    });
    expect(teams.status, teams.text).toBe(201);
    expect((await send(owner, "post", `/api/w/${ws}/channels/${teams.body.id}/test`)).body).toEqual(
      {
        ok: true,
      },
    );
  });
});
