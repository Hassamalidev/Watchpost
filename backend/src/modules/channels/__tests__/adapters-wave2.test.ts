/*
 * P1-T29: the URL- and token-based adapters against mocked provider APIs — the exact request each
 * provider gets, how an incident's later events thread or change the same alert, which failures stop
 * retries, and that stored secrets are write-only.
 */
import { describe, expect, it } from "vitest";
import { CHANNEL_FIELDS, CHANNEL_TYPES, SECRET_MASK } from "@app/shared";
import { createFakeClock } from "../../../core/clock.js";
import { ValidationError } from "../../../core/errors.js";
import type {
  OutboundHttp,
  OutboundRequest,
  OutboundResponse,
} from "../../../infra/http/outbound.js";
import { createDiscordAdapter } from "../adapters/discord.js";
import { createGoogleChatAdapter } from "../adapters/google-chat.js";
import { createGotifyAdapter } from "../adapters/gotify.js";
import { createHomeAssistantAdapter } from "../adapters/home-assistant.js";
import { createMatrixAdapter } from "../adapters/matrix.js";
import { createMattermostAdapter } from "../adapters/mattermost.js";
import { createNtfyAdapter } from "../adapters/ntfy.js";
import { createOpsgenieAdapter } from "../adapters/opsgenie.js";
import { createPagerDutyAdapter } from "../adapters/pagerduty.js";
import { createPushbulletAdapter } from "../adapters/pushbullet.js";
import { createPushoverAdapter } from "../adapters/pushover.js";
import { truncateBytes } from "../adapters/render.js";
import { createRocketChatAdapter } from "../adapters/rocketchat.js";
import { createSlackWebhookAdapter } from "../adapters/slack-webhook.js";
import { createSplunkOnCallAdapter } from "../adapters/splunk-oncall.js";
import { createTeamsAdapter } from "../adapters/teams.js";
import { createWebhookAdapter } from "../adapters/webhook.js";
import { createZulipAdapter } from "../adapters/zulip.js";
import { ChannelDeliveryError, type AlertEvent, type ChannelAdapter } from "../types/adapter.js";

function stub(answer: (req: OutboundRequest) => Partial<OutboundResponse> = () => ({})) {
  const requests: OutboundRequest[] = [];
  const http: OutboundHttp = {
    async request(req) {
      requests.push(req);
      const res = answer(req);
      return { status: res.status ?? 200, headers: {}, body: res.body ?? "{}" };
    },
  };
  return { http, requests, body: (i = -1) => JSON.parse(requests.at(i)?.body ?? "{}") };
}

const INCIDENT_ID = "0190a000-0000-7000-8000-000000000002";

const event = (
  kind: AlertEvent["kind"] = "triggered",
  severity: AlertEvent["incident"]["severity"] = "critical",
): AlertEvent => ({
  kind,
  workspace: { id: "0190a000-0000-7000-8000-000000000001", name: "Acme" },
  incident: {
    id: INCIDENT_ID,
    number: 482,
    title: "Checkout API is down",
    severity,
    status:
      kind === "resolved" ? "resolved" : kind === "acknowledged" ? "acknowledged" : "triggered",
    causeCode: "http_status_unexpected",
    failingRegions: ["eu-central", "us-east"],
    monitorName: "Checkout API",
    startedAt: "2026-10-01T12:00:00.000Z",
    resolvedAt: kind === "resolved" ? "2026-10-01T12:07:00.000Z" : null,
    durationSeconds: 420,
    url: "https://app.example.com/w/acme/incidents/482",
  },
  actor: kind === "acknowledged" ? "Sara" : null,
  at: "2026-10-01T12:00:05.000Z",
  explanation:
    kind === "triggered"
      ? {
          headline: "Gateway error (HTTP 502): the app behind the proxy isn't answering",
          detail: "A proxy in front of shop.example.com is up, but the app behind it is down.",
          nextSteps: ["Check that the application servers behind the load balancer are running."],
        }
      : null,
});

const meta = (threadRef: string | null = null) => ({ idempotencyKey: "delivery.abc", threadRef });

async function deliver<C>(
  adapter: ChannelAdapter<C>,
  config: C,
  e: AlertEvent = event(),
  threadRef: string | null = null,
) {
  return adapter.send(config, adapter.render(e), meta(threadRef));
}

async function failure<C>(adapter: ChannelAdapter<C>, config: C, e: AlertEvent = event()) {
  try {
    await deliver(adapter, config, e);
  } catch (err) {
    if (err instanceof ChannelDeliveryError) return err.permanent ? "permanent" : "transient";
    throw err;
  }
  return "sent";
}

const failsWith = (status: number, body = "") => stub(() => ({ status, body })).http;

describe("Slack incoming webhook", () => {
  const config = { url: "https://hooks.slack.com/services/T0AAA/B0BBB/abcDEF123" };

  it("accepts only incoming-webhook URLs", () => {
    const adapter = createSlackWebhookAdapter({ http: stub().http });
    expect(adapter.parseConfig(config)).toEqual(config);
    for (const url of [
      "https://hooks.slack.com/triggers/T0AAA/123/abc",
      "https://hooks.slack.com.evil.example/services/T0AAA/B0BBB/abc",
      "http://hooks.slack.com/services/T0AAA/B0BBB/abc",
    ]) {
      expect(() => adapter.parseConfig({ url })).toThrow(ValidationError);
    }
  });

  it("posts the same Block Kit message as the app, with a text fallback", async () => {
    const provider = stub(() => ({ body: "ok" }));
    const adapter = createSlackWebhookAdapter({ http: provider.http });
    expect(await deliver(adapter, config)).toEqual({});
    expect(provider.requests[0]?.url).toBe(config.url);
    expect(provider.body(0).text).toBe("[Critical] #482 Checkout API is down");
    expect(provider.body(0).blocks[0].text.text).toBe("🔴 DOWN · Checkout API");
  });

  it("stops on a revoked webhook and retries rate limits", async () => {
    const make = (status: number) => createSlackWebhookAdapter({ http: failsWith(status) });
    expect(await failure(make(404), config)).toBe("permanent");
    expect(await failure(make(410), config)).toBe("permanent");
    expect(await failure(make(429), config)).toBe("transient");
    expect(await failure(make(500), config)).toBe("transient");
  });
});

describe("Google Chat", () => {
  const config = {
    url: "https://chat.googleapis.com/v1/spaces/AAAA/messages?key=k1&token=t1",
  };

  it("accepts only Chat webhook URLs with a key and a token", () => {
    const adapter = createGoogleChatAdapter({ http: stub().http });
    expect(adapter.parseConfig(config)).toEqual(config);
    expect(() =>
      adapter.parseConfig({ url: "https://chat.googleapis.com/v1/spaces/AAAA/messages?key=k1" }),
    ).toThrow(/Google Chat webhook URL/);
    expect(() =>
      adapter.parseConfig({ url: "https://example.com/v1/spaces/A/messages?key=k&token=t" }),
    ).toThrow();
  });

  it("sends a card and keeps an incident's messages in one thread", async () => {
    const provider = stub();
    const adapter = createGoogleChatAdapter({ http: provider.http });
    await deliver(adapter, config);
    const url = new URL(provider.requests[0]?.url ?? "");
    expect(url.searchParams.get("token")).toBe("t1");
    expect(url.searchParams.get("messageReplyOption")).toBe("REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
    const body = provider.body(0);
    expect(body.thread).toEqual({ threadKey: `watchpost-${INCIDENT_ID}` });
    const card = body.cardsV2[0].card;
    expect(card.header.title).toBe("🔴 DOWN · Checkout API");
    expect(JSON.stringify(card)).toContain("Likely cause: Gateway error (HTTP 502)");
    expect(card.sections[0].widgets.at(-1).buttonList.buttons[0].onClick.openLink.url).toBe(
      "https://app.example.com/w/acme/incidents/482",
    );

    await deliver(adapter, config, event("resolved"));
    expect(provider.body(1).thread).toEqual(body.thread);
    await deliver(adapter, config, event("test"));
    expect(provider.body(2).thread).toBeUndefined();
  });

  it("escapes markup in monitor names", async () => {
    const provider = stub();
    const adapter = createGoogleChatAdapter({ http: provider.http });
    const e = event();
    e.incident.monitorName = "<b>shop</b> & co";
    await deliver(adapter, config, e);
    expect(JSON.stringify(provider.body(0).cardsV2[0].card.sections)).toContain(
      "&lt;b&gt;shop&lt;/b&gt; &amp; co",
    );
  });

  it("stops on a deleted webhook and retries throttling", async () => {
    const make = (status: number) => createGoogleChatAdapter({ http: failsWith(status) });
    expect(await failure(make(404), config)).toBe("permanent");
    expect(await failure(make(429), config)).toBe("transient");
  });
});

describe("Mattermost and Rocket.Chat", () => {
  it("Mattermost gets a colored attachment linking to the incident", async () => {
    const provider = stub(() => ({ body: "ok" }));
    const adapter = createMattermostAdapter({ http: provider.http });
    const config = adapter.parseConfig({ url: "https://chat.example.com/hooks/abc123xyz" });
    await deliver(adapter, config);
    const [attachment] = provider.body(0).attachments;
    expect(attachment).toMatchObject({
      color: "#e5484d",
      title: "🔴 DOWN · [Critical] #482 Checkout API is down",
      title_link: "https://app.example.com/w/acme/incidents/482",
    });
    expect(attachment.fields).toContainEqual({
      title: "Failing regions",
      value: "eu-central, us-east",
      short: true,
    });
    await deliver(adapter, config, event("resolved"));
    expect(provider.body(1).attachments[0].color).toBe("#30a46c");
    expect(() => adapter.parseConfig({ url: "https://chat.example.com/api/v4/posts" })).toThrow();
  });

  it("Mattermost works under a sub-path and retries anything but a missing webhook", async () => {
    const adapter = createMattermostAdapter({ http: stub().http });
    const config = adapter.parseConfig({ url: "https://example.com/mattermost/hooks/abc123" });
    expect(config.url).toContain("/mattermost/hooks/");
    const make = (status: number) => createMattermostAdapter({ http: failsWith(status) });
    expect(await failure(make(404), config)).toBe("permanent");
    expect(await failure(make(400), config)).toBe("transient");
    expect(await failure(make(503), config)).toBe("transient");
  });

  it("Rocket.Chat needs the ID and the token, and reports a script's refusal", async () => {
    const provider = stub(() => ({ body: '{"success":true}' }));
    const adapter = createRocketChatAdapter({ http: provider.http });
    const config = adapter.parseConfig({ url: "https://chat.example.com/hooks/65f0/TokenABC" });
    await deliver(adapter, config);
    expect(provider.body(0).text).toBe("[Critical] #482 Checkout API is down");
    expect(provider.body(0).attachments[0].title_link).toContain("/incidents/482");
    expect(() => adapter.parseConfig({ url: "https://chat.example.com/hooks/only-id" })).toThrow(
      /Rocket.Chat incoming webhook URL/,
    );
    const refusing = createRocketChatAdapter({
      http: stub(() => ({ body: '{"success":false,"error":"script said no"}' })).http,
    });
    await expect(deliver(refusing, config)).rejects.toThrow(/script said no/);
  });
});

describe("Zulip", () => {
  const input = {
    serverUrl: "https://acme.zulipchat.com",
    botEmail: "watchpost-bot@acme.zulipchat.com",
    apiKey: "abcdefghijklmnopqrstuvwxyz012345",
    stream: "alerts",
  };

  it("posts as the bot, one topic per monitor unless a topic is set", async () => {
    const provider = stub(() => ({ body: '{"result":"success","id":42}' }));
    const adapter = createZulipAdapter({ http: provider.http });
    const config = adapter.parseConfig(input);
    expect(await deliver(adapter, config)).toEqual({ providerRef: "42" });
    const req = provider.requests[0];
    expect(req?.url).toBe("https://acme.zulipchat.com/api/v1/messages");
    expect(req?.headers?.authorization).toBe(
      `Basic ${Buffer.from(`${input.botEmail}:${input.apiKey}`).toString("base64")}`,
    );
    const form = new URLSearchParams(req?.body);
    expect(Object.fromEntries(form)).toMatchObject({
      type: "stream",
      to: "alerts",
      topic: "Checkout API",
    });
    expect(form.get("content")).toContain("**[Critical] #482 Checkout API is down**");
    expect(form.get("content")).toContain("[Open incident](https://app.example.com/");

    await deliver(adapter, adapter.parseConfig({ ...input, topic: "Production" }));
    expect(new URLSearchParams(provider.requests[1]?.body).get("topic")).toBe("Production");
  });

  it("stops on a wrong key or channel and retries rate limits", async () => {
    const config = createZulipAdapter({ http: stub().http }).parseConfig(input);
    const make = (status: number, body: string) =>
      createZulipAdapter({ http: failsWith(status, body) });
    expect(
      await failure(make(401, '{"result":"error","code":"INVALID_API_KEY","msg":"x"}'), config),
    ).toBe("permanent");
    expect(
      await failure(make(400, '{"result":"error","code":"STREAM_DOES_NOT_EXIST"}'), config),
    ).toBe("permanent");
    expect(await failure(make(429, '{"result":"error","code":"RATE_LIMIT_HIT"}'), config)).toBe(
      "transient",
    );
    await expect(
      deliver(make(400, '{"result":"error","msg":"Channel \'alerts\' does not exist"}'), config),
    ).rejects.toThrow("Zulip refused the message: Channel 'alerts' does not exist");
  });
});

describe("Matrix", () => {
  const input = {
    homeserverUrl: "https://matrix.example.org",
    accessToken: "syt_secret_token",
    roomId: "!abcdef:example.org",
  };

  it("sends an idempotent event and threads follow-ups under the first", async () => {
    const provider = stub(() => ({ body: '{"event_id":"$root"}' }));
    const adapter = createMatrixAdapter({ http: provider.http });
    const config = adapter.parseConfig(input);
    const first = await deliver(adapter, config);
    expect(first.providerRef).toBe("$root");
    const req = provider.requests[0];
    expect(req?.method).toBe("PUT");
    expect(req?.url).toBe(
      "https://matrix.example.org/_matrix/client/v3/rooms/!abcdef%3Aexample.org/send/m.room.message/delivery.abc",
    );
    expect(req?.headers?.authorization).toBe("Bearer syt_secret_token");
    expect(provider.body(0)).toMatchObject({
      msgtype: "m.text",
      format: "org.matrix.custom.html",
    });
    expect(provider.body(0).formatted_body).toContain(
      '<a href="https://app.example.com/w/acme/incidents/482">Open incident</a>',
    );
    expect(provider.body(0)["m.relates_to"]).toBeUndefined();

    await deliver(adapter, config, event("resolved"), "$root");
    expect(provider.body(1)["m.relates_to"]).toEqual({
      rel_type: "m.thread",
      event_id: "$root",
      is_falling_back: true,
      "m.in_reply_to": { event_id: "$root" },
    });
  });

  it("wants a room ID, not an alias, and classifies Matrix errors", async () => {
    const adapter = createMatrixAdapter({ http: stub().http });
    expect(() => adapter.parseConfig({ ...input, roomId: "#ops:example.org" })).toThrow(
      /room ID starting with !/,
    );
    /* Newer room versions have IDs without a server part. */
    expect(
      adapter.parseConfig({ ...input, roomId: "!31hneApxJ_1o-63DmFrpeqnkFfWppnzWso1JvH3ogLM" }),
    ).toBeTruthy();
    const config = adapter.parseConfig(input);
    const make = (status: number, errcode: string) =>
      createMatrixAdapter({ http: failsWith(status, JSON.stringify({ errcode })) });
    expect(await failure(make(403, "M_FORBIDDEN"), config)).toBe("permanent");
    expect(await failure(make(401, "M_UNKNOWN_TOKEN"), config)).toBe("permanent");
    expect(await failure(make(429, "M_LIMIT_EXCEEDED"), config)).toBe("transient");
  });
});

describe("PagerDuty", () => {
  const input = { routingKey: "a".repeat(32) };

  it("opens, acknowledges and resolves one alert per incident", async () => {
    const provider = stub(() => ({ status: 202, body: '{"status":"success"}' }));
    const adapter = createPagerDutyAdapter({ http: provider.http });
    const config = adapter.parseConfig(input);
    expect(config.region).toBe("us");

    const sent = await deliver(adapter, config);
    expect(sent.providerRef).toBe(`watchpost-${INCIDENT_ID}`);
    expect(provider.requests[0]?.url).toBe("https://events.pagerduty.com/v2/enqueue");
    expect(provider.body(0)).toMatchObject({
      routing_key: "a".repeat(32),
      event_action: "trigger",
      dedup_key: `watchpost-${INCIDENT_ID}`,
      client: "Watchpost",
      client_url: "https://app.example.com/w/acme/incidents/482",
      payload: {
        summary: "[Critical] #482 Checkout API is down",
        source: "Checkout API",
        severity: "critical",
        class: "http_status_unexpected",
        custom_details: { failing_regions: ["eu-central", "us-east"] },
      },
    });

    await deliver(adapter, config, event("acknowledged"));
    await deliver(adapter, config, event("resolved"));
    await deliver(adapter, config, event("reminder"));
    expect(provider.requests.slice(1).map((_, i) => provider.body(i + 1).event_action)).toEqual([
      "acknowledge",
      "resolve",
      "trigger",
    ]);
    expect(new Set(provider.requests.map((_, i) => provider.body(i).dedup_key)).size).toBe(1);
    expect(provider.body(1).payload).toBeUndefined();
  });

  it("maps severities and uses the EU endpoint for EU accounts", async () => {
    const provider = stub(() => ({ status: 202 }));
    const adapter = createPagerDutyAdapter({ http: provider.http });
    const config = adapter.parseConfig({ ...input, region: "eu" });
    await deliver(adapter, config, event("triggered", "high"));
    await deliver(adapter, config, event("triggered", "low"));
    expect(provider.requests[0]?.url).toBe("https://events.eu.pagerduty.com/v2/enqueue");
    expect([provider.body(0).payload.severity, provider.body(1).payload.severity]).toEqual([
      "error",
      "warning",
    ]);
  });

  it("a test opens an info alert under its own key and resolves it at once", async () => {
    const provider = stub(() => ({ status: 202 }));
    const adapter = createPagerDutyAdapter({ http: provider.http });
    await deliver(adapter, adapter.parseConfig(input), event("test"));
    expect(provider.requests).toHaveLength(2);
    expect(provider.body(0)).toMatchObject({
      event_action: "trigger",
      dedup_key: "watchpost-test-delivery.abc",
      payload: { severity: "info" },
    });
    expect(provider.body(1)).toMatchObject({
      event_action: "resolve",
      dedup_key: "watchpost-test-delivery.abc",
    });
  });

  it("rejects malformed keys, stops on 400 and keeps retrying throttling for 20 minutes", async () => {
    const adapter = createPagerDutyAdapter({ http: stub().http });
    expect(() => adapter.parseConfig({ routingKey: "too-short" })).toThrow(/32-character/);
    const config = adapter.parseConfig(input);
    const make = (status: number) => createPagerDutyAdapter({ http: failsWith(status) });
    expect(await failure(make(400), config)).toBe("permanent");
    expect(await failure(make(429), config)).toBe("transient");
    expect(await failure(make(502), config)).toBe("transient");
    const { attempts, backoffMs } = adapter.retry!;
    const waitMs = Array.from({ length: attempts - 1 }, (_, i) => backoffMs * 2 ** i).reduce(
      (a, b) => a + b,
    );
    expect(waitMs).toBeGreaterThanOrEqual(15 * 60_000);
    expect(waitMs).toBeLessThanOrEqual(30 * 60_000);
  });
});

describe("Opsgenie and Jira Service Management", () => {
  const input = { apiKey: "eb243592-faa2-4ba2-a551q-1afdf565c88" };

  it("creates, acknowledges and closes one alert by alias", async () => {
    const provider = stub(() => ({ status: 202, body: '{"result":"Request will be processed"}' }));
    const adapter = createOpsgenieAdapter({ http: provider.http });
    const config = adapter.parseConfig(input);
    const alias = `watchpost-${INCIDENT_ID}`;

    await deliver(adapter, config);
    expect(provider.requests[0]?.url).toBe("https://api.opsgenie.com/v2/alerts");
    expect(provider.requests[0]?.headers?.authorization).toBe(`GenieKey ${input.apiKey}`);
    expect(provider.body(0)).toMatchObject({
      alias,
      message: "[Critical] #482 Checkout API is down",
      priority: "P1",
      source: "Watchpost",
      entity: "Checkout API",
      details: { url: "https://app.example.com/w/acme/incidents/482" },
    });

    await deliver(adapter, config, event("acknowledged"));
    expect(provider.requests[1]?.url).toBe(
      `https://api.opsgenie.com/v2/alerts/${alias}/acknowledge?identifierType=alias`,
    );
    expect(provider.body(1)).toMatchObject({ user: "Sara", source: "Watchpost" });
    await deliver(adapter, config, event("resolved"));
    expect(provider.requests[2]?.url).toBe(
      `https://api.opsgenie.com/v2/alerts/${alias}/close?identifierType=alias`,
    );
  });

  it("uses the EU and Jira Service Management endpoints", async () => {
    const provider = stub(() => ({ status: 202 }));
    const adapter = createOpsgenieAdapter({ http: provider.http });
    await deliver(adapter, adapter.parseConfig({ ...input, region: "eu" }));
    await deliver(adapter, adapter.parseConfig({ ...input, region: "jsm" }));
    expect(provider.requests.map((r) => r.url)).toEqual([
      "https://api.eu.opsgenie.com/v2/alerts",
      "https://api.atlassian.com/jsm/ops/integration/v2/alerts",
    ]);
  });

  it("keeps the message within Opsgenie's 130 characters", async () => {
    const provider = stub(() => ({ status: 202 }));
    const adapter = createOpsgenieAdapter({ http: provider.http });
    const e = event();
    e.incident.title = "x".repeat(300);
    await deliver(adapter, adapter.parseConfig(input), e);
    expect(provider.body(0).message).toHaveLength(130);
  });

  it("a test creates a P5 alert and closes it; a disabled key stops retries", async () => {
    const provider = stub(() => ({ status: 202 }));
    const adapter = createOpsgenieAdapter({ http: provider.http });
    const config = adapter.parseConfig(input);
    await deliver(adapter, config, event("test"));
    expect(provider.body(0)).toMatchObject({
      priority: "P5",
      alias: "watchpost-test-delivery.abc",
    });
    expect(provider.requests[1]?.url).toContain("/watchpost-test-delivery.abc/close?");
    const make = (status: number) => createOpsgenieAdapter({ http: failsWith(status) });
    expect(await failure(make(401), config)).toBe("permanent");
    expect(await failure(make(422), config)).toBe("permanent");
    expect(await failure(make(429), config)).toBe("transient");
  });
});

describe("Splunk On-Call", () => {
  const url =
    "https://alert.victorops.com/integrations/generic/20131114/alert/0a1b2c3d-0000-4000-8000-00000000abcd/ops";

  it("asks for the routing key to be filled in", () => {
    const adapter = createSplunkOnCallAdapter({ http: stub().http });
    expect(adapter.parseConfig({ url })).toEqual({ url });
    expect(() => adapter.parseConfig({ url: url.replace(/ops$/, "$routing_key") })).toThrow(
      /replace \$routing_key/,
    );
    expect(() => adapter.parseConfig({ url: "https://alert.victorops.com/" })).toThrow();
  });

  it("maps the incident's life to message types on one entity; a test is INFO", async () => {
    const provider = stub(() => ({ body: '{"result":"success"}' }));
    const adapter = createSplunkOnCallAdapter({ http: provider.http });
    for (const e of [
      event(),
      event("triggered", "low"),
      event("acknowledged"),
      event("resolved"),
      event("test"),
    ]) {
      await deliver(adapter, { url }, e);
    }
    expect(provider.requests.map((_, i) => provider.body(i).message_type)).toEqual([
      "CRITICAL",
      "WARNING",
      "ACKNOWLEDGEMENT",
      "RECOVERY",
      "INFO",
    ]);
    expect(provider.body(0)).toMatchObject({
      entity_id: `watchpost-${INCIDENT_ID}`,
      entity_display_name: "[Critical] #482 Checkout API is down",
      monitoring_tool: "Watchpost",
      "vo_annotate.u.Incident": "https://app.example.com/w/acme/incidents/482",
    });
    expect(provider.body(3).entity_id).toBe(provider.body(0).entity_id);
    expect(provider.body(4).entity_id).toBe("watchpost-test-delivery.abc");
  });

  it("treats a refused alert as permanent and unknown errors as transient", async () => {
    const refused = createSplunkOnCallAdapter({
      http: stub(() => ({ body: '{"result":"failure","message":"Missing fields"}' })).http,
    });
    expect(await failure(refused, { url })).toBe("permanent");
    expect(await failure(createSplunkOnCallAdapter({ http: failsWith(500) }), { url })).toBe(
      "transient",
    );
    expect(await failure(createSplunkOnCallAdapter({ http: failsWith(404) }), { url })).toBe(
      "permanent",
    );
  });
});

describe("Pushover", () => {
  const input = { userKey: "u".repeat(30), appToken: "a".repeat(30) };
  const ok = () => ({ body: '{"status":1,"request":"r1"}' });

  it("sends a titled push that opens the incident; severity sets the priority", async () => {
    const provider = stub(ok);
    const adapter = createPushoverAdapter({ http: provider.http });
    const config = adapter.parseConfig(input);
    await deliver(adapter, config);
    expect(provider.requests[0]?.url).toBe("https://api.pushover.net/1/messages.json");
    expect(provider.body(0)).toMatchObject({
      token: "a".repeat(30),
      user: "u".repeat(30),
      title: "[Critical] #482 Checkout API is down",
      url: "https://app.example.com/w/acme/incidents/482",
      url_title: "Open incident",
      priority: 1,
      timestamp: 1790856005,
    });
    expect(provider.body(0).message).toContain("Failing regions: eu-central, us-east");
    expect(provider.body(0).retry).toBeUndefined();

    await deliver(adapter, config, event("triggered", "low"));
    await deliver(adapter, config, event("resolved"));
    expect([provider.body(1).priority, provider.body(2).priority]).toEqual([0, 0]);
  });

  it("emergency mode repeats critical alerts and cancels them once handled", async () => {
    const provider = stub(ok);
    const adapter = createPushoverAdapter({ http: provider.http });
    const config = adapter.parseConfig({ ...input, critical: "emergency" });
    await deliver(adapter, config);
    expect(provider.body(0)).toMatchObject({
      priority: 2,
      retry: 60,
      expire: 3600,
      tags: `watchpost-${INCIDENT_ID}`,
    });
    /* High severity is loud but doesn't repeat. */
    await deliver(adapter, config, event("triggered", "high"));
    expect(provider.body(1)).toMatchObject({ priority: 1 });
    expect(provider.body(1).tags).toBeUndefined();

    await deliver(adapter, config, event("acknowledged"));
    expect(provider.requests[2]?.url).toBe(
      `https://api.pushover.net/1/receipts/cancel_by_tag/watchpost-${INCIDENT_ID}.json`,
    );
    expect(provider.body(2)).toEqual({ token: "a".repeat(30) });
    expect(provider.requests[3]?.url).toBe("https://api.pushover.net/1/messages.json");
  });

  it("a failed cancel doesn't stop the follow-up, and no 4xx is ever retried", async () => {
    const provider = stub((req) =>
      req.url.includes("cancel_by_tag") ? { status: 500, body: "{}" } : ok(),
    );
    const adapter = createPushoverAdapter({ http: provider.http });
    const config = adapter.parseConfig({ ...input, critical: "emergency" });
    await expect(deliver(adapter, config, event("resolved"))).resolves.toEqual({});

    const make = (status: number, body: string) =>
      createPushoverAdapter({ http: failsWith(status, body) });
    expect(
      await failure(make(400, '{"status":0,"errors":["user identifier is invalid"]}'), config),
    ).toBe("permanent");
    expect(await failure(make(429, '{"status":0}'), config)).toBe("permanent");
    expect(await failure(make(500, ""), config)).toBe("transient");
    await expect(
      deliver(make(400, '{"status":0,"errors":["application token is invalid"]}'), config),
    ).rejects.toThrow("Pushover refused the message: application token is invalid");
    expect(() => adapter.parseConfig({ ...input, userKey: "short" })).toThrow(/30-character/);
  });
});

describe("Pushbullet", () => {
  it("pushes a link with the delivery key as guid, optionally to a channel", async () => {
    const provider = stub(() => ({ body: '{"iden":"ujpah72o0sjAoRtnM0jc"}' }));
    const adapter = createPushbulletAdapter({ http: provider.http });
    const config = adapter.parseConfig({ accessToken: "o.abcdefghijklmnopqrstuvwxyz" });
    expect(await deliver(adapter, config)).toEqual({ providerRef: "ujpah72o0sjAoRtnM0jc" });
    expect(provider.requests[0]?.url).toBe("https://api.pushbullet.com/v2/pushes");
    expect(provider.requests[0]?.headers?.["access-token"]).toBe("o.abcdefghijklmnopqrstuvwxyz");
    expect(provider.body(0)).toMatchObject({
      type: "link",
      title: "[Critical] #482 Checkout API is down",
      url: "https://app.example.com/w/acme/incidents/482",
      guid: "delivery.abc",
    });
    expect(provider.body(0).channel_tag).toBeUndefined();

    await deliver(
      adapter,
      adapter.parseConfig({ accessToken: "o.abcdefghijklmnopqrstuvwxyz", channelTag: "acme-ops" }),
    );
    expect(provider.body(1).channel_tag).toBe("acme-ops");
    expect(await failure(createPushbulletAdapter({ http: failsWith(401) }), config)).toBe(
      "permanent",
    );
    expect(await failure(createPushbulletAdapter({ http: failsWith(429) }), config)).toBe(
      "transient",
    );
  });
});

describe("ntfy", () => {
  it("publishes JSON to the server root with priority, tags, a tap target and a sequence", async () => {
    const provider = stub(() => ({ body: '{"id":"xE73Iyuabi"}' }));
    const adapter = createNtfyAdapter({ http: provider.http });
    const config = adapter.parseConfig({ topic: "acme-alerts" });
    expect(config.serverUrl).toBe("https://ntfy.sh");
    expect(await deliver(adapter, config)).toEqual({ providerRef: "xE73Iyuabi" });
    expect(provider.requests[0]?.url).toBe("https://ntfy.sh");
    expect(provider.requests[0]?.headers?.authorization).toBeUndefined();
    expect(provider.body(0)).toMatchObject({
      topic: "acme-alerts",
      title: "[Critical] #482 Checkout API is down",
      priority: 5,
      tags: ["rotating_light"],
      click: "https://app.example.com/w/acme/incidents/482",
      sequence_id: `watchpost-${INCIDENT_ID}`,
      actions: [{ action: "view", label: "Open incident" }],
    });
    expect(provider.body(0).message).toContain("Likely cause: Gateway error (HTTP 502)");

    await deliver(adapter, config, event("resolved"));
    expect(provider.body(1)).toMatchObject({
      priority: 3,
      tags: ["white_check_mark"],
      sequence_id: provider.body(0).sequence_id,
    });
    await deliver(adapter, config, event("triggered", "high"));
    expect(provider.body(2).priority).toBe(4);
  });

  it("authenticates on self-hosted servers and keeps messages under ntfy's limits", async () => {
    const provider = stub();
    const adapter = createNtfyAdapter({ http: provider.http });
    const config = adapter.parseConfig({
      serverUrl: "https://ntfy.example.com",
      topic: "ops",
      accessToken: "tk_abcdefghijklmnopqrstuvwxyz012",
    });
    const e = event();
    e.incident.title = "é".repeat(600);
    e.explanation = { headline: "界".repeat(3_000), detail: "", nextSteps: [] };
    await deliver(adapter, config, e);
    expect(provider.requests[0]?.url).toBe("https://ntfy.example.com");
    expect(provider.requests[0]?.headers?.authorization).toBe(
      "Bearer tk_abcdefghijklmnopqrstuvwxyz012",
    );
    expect(provider.body(0).title.length).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(provider.body(0).message)).toBeLessThanOrEqual(3_800);
    expect(() => adapter.parseConfig({ topic: "has spaces" })).toThrow();
    /* A topic URL pasted as the server would publish raw JSON to that topic. */
    expect(() =>
      adapter.parseConfig({ serverUrl: "https://ntfy.sh/mytopic", topic: "ops" }),
    ).toThrow(/topic goes in its own field/);
    expect(() => adapter.parseConfig({ topic: "ops", accessToken: "tk_abc\u2026defgh" })).toThrow(
      /special characters/,
    );
    expect(() =>
      adapter.parseConfig({ serverUrl: "http://ntfy.example.com", topic: "ops" }),
    ).toThrow(/https/);
  });

  it("retries request-rate limits but not a used-up daily quota", async () => {
    const config = createNtfyAdapter({ http: stub().http }).parseConfig({ topic: "ops" });
    const make = (status: number, body: string) =>
      createNtfyAdapter({ http: failsWith(status, body) });
    expect(await failure(make(429, '{"code":42901,"error":"limit reached"}'), config)).toBe(
      "transient",
    );
    expect(await failure(make(429, '{"code":42908,"error":"daily quota"}'), config)).toBe(
      "permanent",
    );
    expect(await failure(make(403, '{"code":40301,"error":"forbidden"}'), config)).toBe(
      "permanent",
    );
    expect(await failure(make(502, ""), config)).toBe("transient");
  });

  it("truncateBytes never splits a character", () => {
    const cut = truncateBytes("界".repeat(100), 50);
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(50);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut).not.toContain("�");
    expect(truncateBytes("short", 50)).toBe("short");
  });
});

describe("Gotify", () => {
  it("posts Markdown with the app token, a click target and a priority, under a sub-path too", async () => {
    const provider = stub(() => ({ body: '{"id":25}' }));
    const adapter = createGotifyAdapter({ http: provider.http });
    const config = adapter.parseConfig({
      serverUrl: "https://example.com/gotify/",
      appToken: "AbCdEf123456",
    });
    expect(await deliver(adapter, config)).toEqual({ providerRef: "25" });
    expect(provider.requests[0]?.url).toBe("https://example.com/gotify/message");
    expect(provider.requests[0]?.headers?.["x-gotify-key"]).toBe("AbCdEf123456");
    expect(provider.body(0)).toMatchObject({
      title: "[Critical] #482 Checkout API is down",
      priority: 10,
      extras: {
        "client::display": { contentType: "text/markdown" },
        "client::notification": {
          click: { url: "https://app.example.com/w/acme/incidents/482" },
        },
      },
    });
    expect(provider.body(0).message).toContain("- **Monitor:** Checkout API");
    await deliver(adapter, config, event("resolved"));
    expect(provider.body(1).priority).toBe(4);
    expect(await failure(createGotifyAdapter({ http: failsWith(401) }), config)).toBe("permanent");
    expect(() =>
      adapter.parseConfig({ serverUrl: "https://example.com/?token=x", appToken: "AbCdEf123456" }),
    ).toThrow(/server address only/);
  });
});

describe("Teams workflow URLs", () => {
  const adapter = createTeamsAdapter({ http: stub().http });

  it("accepts Power Automate and sovereign-cloud hosts with a port and a scale unit", () => {
    for (const url of [
      "https://default0a1b.2c.environment.api.powerplatform.com:443/powerautomate/automations/direct/cu/20/workflows/abc/triggers/manual/paths/invoke?api-version=1&sig=x",
      "https://prod-12.westeurope.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=x",
      "https://x.api.gov.powerplatform.microsoft.us/workflows/abc?sig=x",
      "https://prod-1.chinaeast.logic.azure.cn/workflows/abc?sig=x",
    ]) {
      expect(adapter.parseConfig({ url })).toEqual({ url });
    }
  });

  it("explains that Office 365 connector URLs were retired", () => {
    expect(() =>
      adapter.parseConfig({
        url: "https://acme.webhook.office.com/webhookb2/abc/IncomingWebhook/x",
      }),
    ).toThrow(/retired in May 2026/);
  });
});

describe("write-only secrets", () => {
  it("every form-based adapter masks what the catalog marks as secret", async () => {
    const http = stub().http;
    const samples: Array<[ChannelAdapter<never>, Record<string, unknown>]> = [
      [
        createSlackWebhookAdapter({ http }),
        { url: "https://hooks.slack.com/services/T0A/B0B/abc" },
      ],
      [createDiscordAdapter({ http }), { url: "https://discord.com/api/webhooks/1/abc" }],
      [
        createTeamsAdapter({ http }),
        { url: "https://prod-1.westus.logic.azure.com/workflows/x?sig=secret" },
      ],
      [
        createGoogleChatAdapter({ http }),
        { url: "https://chat.googleapis.com/v1/spaces/A/messages?key=k&token=t" },
      ],
      [createPagerDutyAdapter({ http }), { routingKey: "b".repeat(32), region: "us" }],
      [createPushoverAdapter({ http }), { userKey: "u".repeat(30), appToken: "a".repeat(30) }],
      [
        createZulipAdapter({ http }),
        {
          serverUrl: "https://acme.zulipchat.com",
          botEmail: "bot@acme.zulipchat.com",
          apiKey: "k".repeat(32),
          stream: "alerts",
        },
      ],
    ] as never;
    for (const [adapter, input] of samples) {
      const config = await adapter.prepare!(input, { workspaceId: "w", previous: undefined });
      const shown = adapter.redact!(config);
      const text = JSON.stringify(shown);
      for (const field of CHANNEL_FIELDS[adapter.type].filter((f) => f.secret)) {
        expect(text, `${adapter.type}.${field.key}`).not.toContain(String(input[field.key]));
        expect(String(shown[field.key])).toContain(SECRET_MASK);
      }
    }
    /* A secret URL still shows where it points. */
    const discord = createDiscordAdapter({ http });
    expect(discord.redact!({ url: "https://discord.com/api/webhooks/1/abc" })).toEqual({
      url: `https://discord.com/${SECRET_MASK}`,
    });
  });

  it("an empty or masked secret keeps the stored one on update", async () => {
    const adapter = createZulipAdapter({ http: stub().http });
    const stored = adapter.parseConfig({
      serverUrl: "https://acme.zulipchat.com",
      botEmail: "bot@acme.zulipchat.com",
      apiKey: "k".repeat(32),
      stream: "alerts",
    });
    for (const apiKey of [undefined, "", SECRET_MASK]) {
      const next = await adapter.prepare!(
        { ...stored, apiKey, stream: "incidents" },
        { workspaceId: "w", previous: stored },
      );
      expect(next).toMatchObject({ apiKey: "k".repeat(32), stream: "incidents" });
    }
    const replaced = await adapter.prepare!(
      { ...stored, apiKey: "n".repeat(32) },
      { workspaceId: "w", previous: stored },
    );
    expect(replaced.apiKey).toBe("n".repeat(32));
  });

  it("a secret URL sent back masked keeps the stored URL", async () => {
    const adapter = createSlackWebhookAdapter({ http: stub().http });
    const stored = { url: "https://hooks.slack.com/services/T0A/B0B/abc" };
    const kept = await adapter.prepare!(
      { url: `https://hooks.slack.com/${SECRET_MASK}` },
      { workspaceId: "w", previous: stored },
    );
    expect(kept).toEqual(stored);
  });

  it("moving the server means entering the secret again", async () => {
    const adapter = createGotifyAdapter({ http: stub().http });
    const stored = adapter.parseConfig({
      serverUrl: "https://gotify.example.com",
      appToken: "AbCdEf123456",
    });
    const moved = adapter.prepare!(
      { serverUrl: "https://collector.example.net", appToken: SECRET_MASK },
      { workspaceId: "w", previous: stored },
    );
    await expect(moved).rejects.toMatchObject({
      fieldErrors: [{ path: "body.config.appToken" }],
    });
    /* Another path on the same host counts too: hosted services tell tenants apart by path. */
    await expect(
      adapter.prepare!(
        { serverUrl: "https://gotify.example.com/other-tenant", appToken: "" },
        { workspaceId: "w", previous: stored },
      ),
    ).rejects.toThrow(/enter appToken again/);
    const samePlace = await adapter.prepare!(
      { serverUrl: "https://gotify.example.com/", appToken: "" },
      { workspaceId: "w", previous: stored },
    );
    expect(samePlace.appToken).toBe("AbCdEf123456");
  });

  it("a mask without a stored secret is refused, and null removes an optional secret", async () => {
    const pagerduty = createPagerDutyAdapter({ http: stub().http });
    await expect(
      pagerduty.prepare!({ routingKey: SECRET_MASK }, { workspaceId: "w", previous: undefined }),
    ).rejects.toMatchObject({
      fieldErrors: [{ path: "body.config.routingKey", message: "is required" }],
    });

    const ntfy = createNtfyAdapter({ http: stub().http });
    const stored = ntfy.parseConfig({ topic: "ops", accessToken: "tk_abcdefghijklmnop" });
    const kept = await ntfy.prepare!({ topic: "ops" }, { workspaceId: "w", previous: stored });
    expect(kept.accessToken).toBe("tk_abcdefghijklmnop");
    const removed = await ntfy.prepare!(
      { topic: "ops", accessToken: null },
      { workspaceId: "w", previous: stored },
    );
    expect(removed.accessToken).toBeUndefined();
  });

  it("validation errors name the field in plain words", () => {
    try {
      createPushoverAdapter({ http: stub().http }).parseConfig({ userKey: "u".repeat(30) });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toBe("Pushover: appToken is required");
      expect((err as ValidationError).fieldErrors).toEqual([
        { path: "body.config.appToken", message: "is required" },
      ]);
    }
  });
});

describe("webhook custom headers", () => {
  const clock = createFakeClock("2026-10-01T12:00:05Z");
  const base = { url: "https://hooks.example.com/in" };

  it("sends them with every request but never over the signature", async () => {
    const provider = stub();
    const adapter = createWebhookAdapter({ http: provider.http, clock });
    const config = await adapter.prepare!(
      { ...base, headers: { Authorization: "Bearer zap-token", "X-Team": "ops" } },
      { workspaceId: "w", previous: undefined },
    );
    await deliver(adapter, config);
    const headers = provider.requests[0]?.headers ?? {};
    expect(headers).toMatchObject({
      Authorization: "Bearer zap-token",
      "X-Team": "ops",
      "content-type": "application/json",
    });
    expect(headers["watchpost-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it("refuses reserved names, bad values and more than ten", async () => {
    const adapter = createWebhookAdapter({ http: stub().http, clock });
    const prepare = (headers: Record<string, string>) =>
      adapter.prepare!({ ...base, headers }, { workspaceId: "w", previous: undefined });
    await expect(prepare({ "Watchpost-Signature": "forged" })).rejects.toThrow(/reserved/);
    await expect(prepare({ "Content-Type": "text/plain" })).rejects.toThrow(/set by Watchpost/);
    await expect(prepare({ Host: "internal" })).rejects.toThrow();
    await expect(prepare({ "Bad Name": "x" })).rejects.toThrow(/not a valid header name/);
    await expect(prepare({ "X-Inject": "a\r\nEvil: 1" })).rejects.toThrow(/printable ASCII/);
    await expect(
      prepare(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`X-H${i}`, "v"]))),
    ).rejects.toThrow(/at most 10/);
  });

  it("shows header names only, and keeps masked values while the server stays the same", async () => {
    const adapter = createWebhookAdapter({ http: stub().http, clock });
    const stored = await adapter.prepare!(
      { ...base, headers: { Authorization: "Bearer zap-token" } },
      { workspaceId: "w", previous: undefined },
    );
    expect(adapter.redact!(stored)).toEqual({
      url: base.url,
      secret: stored.secret,
      headers: { Authorization: SECRET_MASK },
    });

    const kept = await adapter.prepare!(
      { ...base, headers: { authorization: SECRET_MASK, "X-New": "1" } },
      { workspaceId: "w", previous: stored },
    );
    expect(kept.headers).toEqual({ authorization: "Bearer zap-token", "X-New": "1" });
    expect(kept.secret).toBe(stored.secret);

    /* Another server, or another receiver on the same shared host (a different Zap). */
    for (const url of ["https://collector.example.net/in", "https://hooks.example.com/other"]) {
      await expect(
        adapter.prepare!(
          { url, headers: { Authorization: SECRET_MASK } },
          { workspaceId: "w", previous: stored },
        ),
      ).rejects.toThrow(/Authorization header again/);
    }
    const cleared = await adapter.prepare!(base, { workspaceId: "w", previous: stored });
    expect(cleared.headers).toBeUndefined();
  });
});

describe("Home Assistant", () => {
  it("fires the webhook trigger with the alert as JSON, under a sub-path too", async () => {
    const provider = stub();
    const adapter = createHomeAssistantAdapter({ http: provider.http });
    const config = adapter.parseConfig({
      serverUrl: "https://home.example.com/ha/",
      webhookId: "watchpost-alerts-9f2c",
    });
    await deliver(adapter, config);
    expect(provider.requests[0]?.url).toBe(
      "https://home.example.com/ha/api/webhook/watchpost-alerts-9f2c",
    );
    expect(provider.body(0)).toMatchObject({
      event: "triggered",
      title: "[Critical] #482 Checkout API is down",
      incident: {
        number: 482,
        severity: "critical",
        status: "triggered",
        url: "https://app.example.com/w/acme/incidents/482",
      },
      monitor: "Checkout API",
    });
    await deliver(adapter, config, event("resolved"));
    expect(provider.body(1).event).toBe("resolved");
    /* A deleted automation answers 404 or 405: retrying can't help. */
    for (const status of [404, 405]) {
      expect(await failure(createHomeAssistantAdapter({ http: failsWith(status) }), config)).toBe(
        "permanent",
      );
    }
    expect(await failure(createHomeAssistantAdapter({ http: failsWith(502) }), config)).toBe(
      "transient",
    );
    expect(() =>
      adapter.parseConfig({ serverUrl: "http://home.local", webhookId: "watchpost-alerts" }),
    ).toThrow();
    expect(() =>
      adapter.parseConfig({ serverUrl: "https://home.example.com", webhookId: "has space" }),
    ).toThrow();
  });
});

describe("the adapter registry", () => {
  it("has a config field list for every channel type", () => {
    for (const type of CHANNEL_TYPES) expect(CHANNEL_FIELDS[type], type).toBeDefined();
  });
});
