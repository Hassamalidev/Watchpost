/*
 * P4-T05 against the real container with Slack and Telegram mocked at the HTTP layer: alerts carry
 * Acknowledge and Resolve buttons, a tap in Telegram acknowledges and the Slack message updates, a
 * click in Slack resolves and the Telegram message updates (both well inside five seconds), and
 * forged, stale or replayed presses change nothing.
 */
import { randomBytes } from "node:crypto";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMMAND_HELP, parseDuration, slackSignature } from "../modules/actions/index.js";
import type { AlertingModule } from "../modules/alerting/index.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  signUpVerified,
  stubHttp,
} from "./helpers/container-app.js";

const run = randomBytes(4).toString("hex");
/* Its own Slack team, so earlier runs in the same database don't share it. */
const TEAM = `T0${run.toUpperCase()}`;
const TELEGRAM_SECRET = "telegram-secret-0123456789";
const SLACK_SIGNING_SECRET = "slack-signing-secret-0123456789";
const SLACK_REF = { channel: "C0ZED", ts: "1700000000.000200" };
const TELEGRAM_REF = { chat: -100777, message: 7 };

const http = stubHttp((req) => {
  if (req.url.endsWith("/oauth.v2.access")) {
    return {
      body: JSON.stringify({
        ok: true,
        access_token: "xoxb-secret-token",
        scope: "chat:write,channels:read",
        bot_user_id: "U0BOT",
        team: { id: TEAM, name: "Acme Slack" },
      }),
    };
  }
  if (req.url.includes("slack.com/api/")) return { body: `{"ok":true,"ts":"${SLACK_REF.ts}"}` };
  if (req.url.includes("api.telegram.org")) {
    return { body: `{"ok":true,"result":{"message_id":${TELEGRAM_REF.message}}}` };
  }
  return undefined;
});
const calls = (suffix: string) =>
  http.requests
    .filter((r) => r.url.endsWith(suffix))
    .map((r) => JSON.parse(r.body ?? "{}") as Record<string, unknown>);
const actionIds = (body: Record<string, unknown> | undefined): string[] =>
  ((body?.blocks ?? []) as { type: string; elements?: { action_id: string }[] }[])
    .filter((b) => b.type === "actions")
    .flatMap((b) => (b.elements ?? []).map((e) => e.action_id));
const keyboard = (body: Record<string, unknown> | undefined): string[] =>
  (
    (body?.reply_markup as { inline_keyboard?: { text: string }[][] } | undefined)
      ?.inline_keyboard ?? []
  )
    .flat()
    .map((b) => b.text);

const ctx = buildContainerApp({
  authRateLimit: false,
  http,
  env: {
    SLACK_CLIENT_ID: "111.222",
    SLACK_CLIENT_SECRET: "slack-client-secret",
    SLACK_SIGNING_SECRET,
    TELEGRAM_BOT_TOKEN: "123456:ABC-def",
    TELEGRAM_BOT_USERNAME: "WatchpostTestBot",
    TELEGRAM_WEBHOOK_SECRET: TELEGRAM_SECRET,
  },
});
let owner: TestAgent;
let ws = "";

const alerting = () =>
  (ctx.container.modules.find((m) => m.name === "alerting") as AlertingModule).service;
const api = (method: "get" | "post", path: string) =>
  owner[method](`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN);
const telegram = (body: object, secret = TELEGRAM_SECRET) =>
  request(ctx.app)
    .post("/api/webhooks/telegram")
    .set("x-telegram-bot-api-secret-token", secret)
    .send(body);

function slackClick(payload: object, options: { secret?: string; at?: number } = {}): request.Test {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const timestamp = String(Math.floor((options.at ?? Date.now()) / 1_000));
  return request(ctx.app)
    .post("/api/integrations/slack/actions")
    .set("content-type", "application/x-www-form-urlencoded")
    .set("x-slack-request-timestamp", timestamp)
    .set(
      "x-slack-signature",
      slackSignature(options.secret ?? SLACK_SIGNING_SECRET, timestamp, body),
    )
    .send(body);
}
const slackPayload = (action: string, incidentId: string, ts = SLACK_REF.ts) => ({
  type: "block_actions",
  user: { id: "U0SARA", username: "sara", name: "Sara" },
  container: { channel_id: SLACK_REF.channel, message_ts: ts },
  actions: [{ action_id: action, value: incidentId }],
  response_url: "https://hooks.slack.com/actions/T0ACME/1/abc",
});
const tap = (data: string, messageId = TELEGRAM_REF.message) => ({
  callback_query: {
    id: `cb-${randomBytes(3).toString("hex")}`,
    data,
    from: { id: 4242, first_name: "Omar" },
    message: { message_id: messageId, chat: { id: TELEGRAM_REF.chat } },
  },
});

async function openAndAlert(title: string) {
  const created = await api("post", "/incidents").send({ title, severity: "high" });
  expect(created.status, created.text).toBe(201);
  const incident = { id: created.body.id as string, number: created.body.number as number };
  await follow(incident.id, "triggered");
  return incident;
}

/* What the worker does after an incident event: plan the alerts and send them. */
async function follow(incidentId: string, kind: "triggered" | "acknowledged" | "resolved") {
  await alerting().planIncidentEvent({
    kind,
    incidentId,
    eventKey: `${kind}.${incidentId}.${randomBytes(3).toString("hex")}`,
  });
  for (const delivery of await alerting().deliveriesFor(incidentId)) {
    if (delivery.status === "pending") await alerting().deliver(delivery.id);
  }
}
const statusOf = async (number: number) =>
  (await api("get", `/incidents/${number}`)).body.status as string;

beforeAll(async () => {
  owner = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `twoway-${run}@example.com`);
  const created = await owner
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "Two-way Co", slug: `twoway-${run}` });
  ws = created.body.id as string;

  /* Slack: install, then a channel on #zed. */
  const start = await api("get", "/integrations/slack/install");
  const state = new URL(start.body.url as string).searchParams.get("state") ?? "";
  await owner
    .get(`/api/integrations/slack/callback?code=abc&state=${encodeURIComponent(state)}`)
    .set("Origin", WEB_ORIGIN);
  const installs = await api("get", "/integrations/slack/installations");
  const slack = await api("post", "/channels").send({
    type: "slack",
    name: "Slack #zed",
    config: {
      installationId: installs.body.data[0].id,
      channelId: SLACK_REF.channel,
      channelName: "zed",
    },
  });
  expect(slack.status, slack.text).toBe(201);

  /* Telegram: a channel linked to the chat that opens its deep link. */
  const tg = await api("post", "/channels").send({
    type: "telegram",
    name: "Ops Telegram",
    config: {},
  });
  expect(tg.status, tg.text).toBe(201);
  const link = await api("post", `/channels/${tg.body.id}/telegram-link`);
  const token = new URL(link.body.url as string).searchParams.get("start") ?? "";
  const linked = await telegram({
    message: { text: `/start ${token}`, chat: { id: TELEGRAM_REF.chat, title: "Ops room" } },
  });
  expect(linked.status).toBe(200);

  for (const id of [slack.body.id, tg.body.id] as string[]) {
    const routed = await owner
      .put(`/api/w/${ws}/alert-policies/default/channels/${id}`)
      .set("Origin", WEB_ORIGIN);
    expect(routed.status, routed.text).toBe(200);
  }
}, 120_000);

afterAll(async () => {
  await ctx.container.close();
});

describe("alerts that can be answered", () => {
  it("carry Acknowledge and Resolve in Slack and Telegram", async () => {
    await openAndAlert("Checkout down");
    expect(actionIds(calls("/chat.postMessage").at(-1))).toEqual([
      "watchpost_acknowledge",
      "watchpost_resolve",
      "open_incident",
    ]);
    const sent = calls("/sendMessage").at(-1);
    expect(keyboard(sent)).toEqual(["Acknowledge", "Resolve"]);
  });

  it("acknowledge from a Telegram tap, and Slack shows it within five seconds", async () => {
    const incident = await openAndAlert("Search slow");
    const started = Date.now();
    const answered = await telegram(tap(`ack:${incident.id}`));
    expect(answered.status).toBe(200);
    expect(await statusOf(incident.number)).toBe("acknowledged");
    expect(calls("/answerCallbackQuery").at(-1)?.text).toBe(
      `#${incident.number} acknowledged by Omar.`,
    );

    await follow(incident.id, "acknowledged");
    const update = calls("/chat.update").at(-1);
    expect(update).toMatchObject({ channel: SLACK_REF.channel, ts: SLACK_REF.ts });
    /* Nothing left to acknowledge; resolving is still offered. */
    expect(actionIds(update)).toEqual(["watchpost_resolve", "open_incident"]);
    expect(keyboard(calls("/editMessageText").at(-1))).toEqual(["Resolve"]);
    /* The follow-up in the thread is a plain reply: only the first message acts. */
    expect(actionIds(calls("/chat.postMessage").at(-1))).toEqual(["open_incident"]);
    expect(Date.now() - started).toBeLessThan(5_000);

    const again = await telegram(tap(`ack:${incident.id}`));
    expect(again.status).toBe(200);
    expect(calls("/answerCallbackQuery").at(-1)?.text).toBe(
      `#${incident.number} is already acknowledged.`,
    );
  });

  it("resolve from a Slack click, and Telegram shows it within five seconds", async () => {
    const incident = await openAndAlert("API errors");
    const started = Date.now();
    const clicked = await slackClick(slackPayload("watchpost_resolve", incident.id));
    expect(clicked.status).toBe(200);
    expect(await statusOf(incident.number)).toBe("resolved");
    const whisper = http.requests.find((r) => r.url.startsWith("https://hooks.slack.com/actions/"));
    const said = JSON.parse(whisper?.body ?? "{}") as { text: string };
    expect(said).toMatchObject({ response_type: "ephemeral", replace_original: false });
    /* Sara hasn't linked her Slack user yet, so she is shown how. */
    expect(said.text).toMatch(
      new RegExp(`^#${incident.number} resolved by Sara\. Link your Slack user .*link=`),
    );

    await follow(incident.id, "resolved");
    const edited = calls("/editMessageText").at(-1);
    expect(edited?.text).toContain("API errors");
    expect(keyboard(edited)).toEqual([]);
    expect(actionIds(calls("/chat.update").at(-1))).toEqual(["open_incident"]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("presses that must not work", () => {
  it("refuses a forged or stale Slack request", async () => {
    const incident = await openAndAlert("Forged");
    const payload = slackPayload("watchpost_acknowledge", incident.id);
    expect((await slackClick(payload, { secret: "another-secret-0123456789" })).status).toBe(401);
    expect((await slackClick(payload, { at: Date.now() - 10 * 60_000 })).status).toBe(401);
    const unsigned = await request(ctx.app)
      .post("/api/integrations/slack/actions")
      .set("content-type", "application/x-www-form-urlencoded")
      .send("payload=%7B%7D");
    expect(unsigned.status).toBe(401);
    expect(await statusOf(incident.number)).toBe("triggered");
  });

  it("refuses a Telegram update without our secret", async () => {
    const incident = await openAndAlert("No secret");
    expect((await telegram(tap(`ack:${incident.id}`), "wrong-secret-0000000000")).status).toBe(401);
    expect(await statusOf(incident.number)).toBe("triggered");
  });

  it("acts only on the message we sent for that incident", async () => {
    const incident = await openAndAlert("Replay");
    /* A real signature, but from a message that isn't this incident's alert. */
    const elsewhere = await slackClick(
      slackPayload("watchpost_acknowledge", incident.id, "1699999999.000100"),
    );
    expect(elsewhere.status).toBe(200);
    const otherChat = await telegram(tap(`res:${incident.id}`, 9_999));
    expect(otherChat.status).toBe(200);
    expect(calls("/answerCallbackQuery").at(-1)?.text).toBe(
      "This button no longer works. Open the incident in Watchpost.",
    );
    const nonsense = await telegram(tap("ack:not-an-incident"));
    expect(nonsense.status).toBe(200);
    expect(await statusOf(incident.number)).toBe("triggered");
  });
});

describe("/watchpost in Slack", () => {
  function command(text: string, options: { secret?: string; user?: string } = {}) {
    const body = new URLSearchParams({
      team_id: TEAM,
      user_id: options.user ?? "U0SARA",
      user_name: "sara",
      text,
    }).toString();
    const timestamp = String(Math.floor(Date.now() / 1_000));
    return request(ctx.app)
      .post("/api/integrations/slack/commands")
      .set("content-type", "application/x-www-form-urlencoded")
      .set("x-slack-request-timestamp", timestamp)
      .set(
        "x-slack-signature",
        slackSignature(options.secret ?? SLACK_SIGNING_SECRET, timestamp, body),
      )
      .send(body);
  }
  const say = async (text: string, user?: string) => {
    const started = Date.now();
    const res = await command(text, user === undefined ? {} : { user });
    expect(res.status, res.text).toBe(200);
    expect(res.body.response_type).toBe("ephemeral");
    /* Slack gives a command three seconds. */
    expect(Date.now() - started).toBeLessThan(3_000);
    return res.body.text as string;
  };

  it("reads durations like 30m, 1h and 2h30m, up to a day", () => {
    expect(parseDuration("30m")).toBe(30 * 60_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("2h30m")).toBe(150 * 60_000);
    expect(parseDuration("24h")).toBe(24 * 3_600_000);
    expect(parseDuration("25h")).toBeUndefined();
    expect(parseDuration("0m")).toBeUndefined();
    expect(parseDuration("soon")).toBeUndefined();
    expect(parseDuration("")).toBeUndefined();
  });

  it("refuses a request Slack didn't sign, and explains itself on help", async () => {
    expect((await command("help", { secret: "another-secret-0123456789" })).status).toBe(401);
    expect(await say("")).toBe(COMMAND_HELP);
    expect(await say("help")).toBe(COMMAND_HELP);
    expect(await say("dance")).toBe(COMMAND_HELP);
  });

  it("acknowledges and resolves by number for anyone in the Slack workspace", async () => {
    const incident = await openAndAlert("By number");
    expect(await say(`ack #${incident.number}`)).toBe(
      `Acknowledged #${incident.number} By number.`,
    );
    expect(await say(`ack ${incident.number}`)).toBe(
      `#${incident.number} By number is already acknowledged.`,
    );
    expect(await say(`resolve ${incident.number}`)).toBe(`Resolved #${incident.number} By number.`);
    expect(await statusOf(incident.number)).toBe("resolved");
    expect(await say("ack")).toContain("Which incident?");
    expect(await say("ack 99999999")).toMatch(/not found/i);
    expect(await say("oncall")).toBe("No on-call schedules yet.");
  });

  it("keeps maintenance for linked accounts, and tells an unlinked user how to link", async () => {
    const refused = await say("maintenance 1h");
    expect(refused).toContain("Link it first");
    expect(refused).toMatch(/\/notifications\?link=/);
  });

  it("links a Slack user to the signed-in member, whose clicks are then recorded as theirs", async () => {
    const offered = await say("link");
    const url = new URL(/https?:\/\/\S+/.exec(offered)?.[0] ?? "");
    expect(url.pathname).toBe(`/w/${ws}/notifications`);
    const token = url.searchParams.get("link") ?? "";

    const preview = await api("get", `/me/chat-links/preview?token=${encodeURIComponent(token)}`);
    expect(preview.body.data).toEqual({ provider: "slack", externalName: "sara" });
    const forged = await api("post", "/me/chat-links").send({ token: `${token.slice(0, -4)}AAAA` });
    expect(forged.status).toBe(400);
    const claimed = await api("post", "/me/chat-links").send({ token });
    expect(claimed.status, claimed.text).toBe(201);
    expect(claimed.body.data).toEqual([
      expect.objectContaining({ provider: "slack", externalName: "sara" }),
    ]);
    expect(await say("link")).toBe("Your Slack user is already linked to your Watchpost account.");

    /* A click is now the member's own, and nobody is asked to link again. */
    const me = (await api("get", "/members")).body.data[0].userId as string;
    const incident = await openAndAlert("Linked click");
    const before = http.requests.length;
    await slackClick(slackPayload("watchpost_acknowledge", incident.id));
    const detail = await api("get", `/incidents/${incident.number}`);
    expect(detail.body.status).toBe("acknowledged");
    expect(detail.body.acknowledgedBy).toBe(me);
    const whisper = http.requests
      .slice(before)
      .find((r) => r.url.startsWith("https://hooks.slack.com/actions/"));
    expect(JSON.parse(whisper?.body ?? "{}").text).toBe(
      `#${incident.number} acknowledged by Sara.`,
    );

    /* Another Slack user in the same team is still a stranger. */
    expect(await say("maintenance 1h", "U0OTHER")).toContain("Link it first");
  });

  it("starts maintenance for a linked member, for all monitors or the ones named", async () => {
    const all = await say("maintenance 1h");
    expect(all).toMatch(/^Maintenance started for all monitors until /);
    expect(await say("maintenance 2h nothing-is-called-this")).toBe(
      "No monitor is named like “nothing-is-called-this”.",
    );
    expect(await say("maintenance soon")).toContain("How long?");
    const windows = await api("get", "/maintenance-windows");
    const started = (windows.body.data as { name: string; active: boolean }[]).find((w) =>
      w.name.startsWith("Started from Slack"),
    );
    expect(started).toMatchObject({ name: "Started from Slack by sara", active: true });

    const links = await api("get", "/me/chat-links");
    const removed = await owner
      .delete(`/api/w/${ws}/me/chat-links/${links.body.data[0].id}`)
      .set("Origin", WEB_ORIGIN);
    expect(removed.status).toBe(204);
    expect(await say("maintenance 1h")).toContain("Link it first");
  });
});
