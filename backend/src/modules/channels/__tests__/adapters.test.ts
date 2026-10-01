/*
 * P1-T13 AC: every wave-1 adapter against mocked provider APIs — the request each provider gets,
 * threading and message updates, and which failures are permanent (no retry) or transient.
 */
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createAddressPolicy } from "@app/shared";
import { createFakeClock } from "../../../core/clock.js";
import {
  createOutboundHttp,
  type OutboundHttp,
  type OutboundRequest,
  type OutboundResponse,
} from "../../../infra/http/outbound.js";
import { createDiscordAdapter } from "../adapters/discord.js";
import { createSlackAdapter } from "../adapters/slack.js";
import { createTeamsAdapter } from "../adapters/teams.js";
import { createTelegramAdapter, createTelegramApi } from "../adapters/telegram.js";
import { createWebhookAdapter } from "../adapters/webhook.js";
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

const event = (
  kind: AlertEvent["kind"] = "triggered",
  actor: string | null = null,
): AlertEvent => ({
  kind,
  workspace: { id: "0190a000-0000-7000-8000-000000000001", name: "Acme" },
  incident: {
    id: "0190a000-0000-7000-8000-000000000002",
    number: 482,
    title: "Checkout API is down",
    severity: "critical",
    status: kind === "resolved" ? "resolved" : "triggered",
    causeCode: "http_status_unexpected",
    failingRegions: ["eu-central", "us-east"],
    monitorName: "Checkout API",
    startedAt: "2026-10-01T12:00:00.000Z",
    resolvedAt: kind === "resolved" ? "2026-10-01T12:07:00.000Z" : null,
    durationSeconds: 420,
    url: "https://app.example.com/w/acme/incidents/482",
  },
  actor,
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

async function failure<C>(adapter: ChannelAdapter<C>, config: C) {
  try {
    await adapter.send(config, adapter.render(event()), meta());
  } catch (err) {
    if (err instanceof ChannelDeliveryError) return err.permanent ? "permanent" : "transient";
    throw err;
  }
  return "sent";
}

describe("webhook adapter", () => {
  const clock = createFakeClock("2026-10-01T12:00:05Z");

  it("signs the JSON envelope and sends a stable event ID", async () => {
    const provider = stub();
    const adapter = createWebhookAdapter({ http: provider.http, clock });
    const config = adapter.parseConfig({
      url: "https://hooks.example.com/in",
      secret: "s".repeat(32),
    });
    await adapter.send(config, adapter.render(event()), meta());

    const req = provider.requests[0];
    expect(req?.headers?.["watchpost-event-id"]).toBe("delivery.abc");
    const body = req?.body ?? "";
    const expected = createHmac("sha256", "s".repeat(32))
      .update(`1790856005.${body}`)
      .digest("hex");
    expect(req?.headers?.["watchpost-signature"]).toBe(`t=1790856005,v1=${expected}`);
    expect(JSON.parse(body)).toMatchObject({
      id: "delivery.abc",
      type: "incident.triggered",
      workspace: { name: "Acme" },
      incident: { number: 482, severity: "critical", failingRegions: ["eu-central", "us-east"] },
      monitor: { name: "Checkout API" },
    });
  });

  it("generates a secret, keeps it on update, and retries for about an hour", async () => {
    const adapter = createWebhookAdapter({ http: stub().http, clock });
    const created = await adapter.prepare!(
      { url: "https://hooks.example.com/in" },
      {
        workspaceId: "w",
        previous: undefined,
      },
    );
    expect(created.secret).toMatch(/^whsec_/);
    const updated = await adapter.prepare!(
      { url: "https://hooks.example.com/v2" },
      {
        workspaceId: "w",
        previous: created,
      },
    );
    expect(updated).toEqual({ url: "https://hooks.example.com/v2", secret: created.secret });
    const { attempts, backoffMs } = adapter.retry!;
    const totalWaitMs = Array.from({ length: attempts - 1 }, (_, i) => backoffMs * 2 ** i).reduce(
      (a, b) => a + b,
    );
    expect(totalWaitMs).toBeGreaterThanOrEqual(55 * 60_000);
    expect(totalWaitMs).toBeLessThanOrEqual(75 * 60_000);
  });

  it("retries server errors, gives up on 410, and never reaches private addresses", async () => {
    const config = { url: "https://hooks.example.com/in", secret: "s".repeat(32) };
    expect(
      await failure(
        createWebhookAdapter({ http: stub(() => ({ status: 500 })).http, clock }),
        config,
      ),
    ).toBe("transient");
    expect(
      await failure(
        createWebhookAdapter({ http: stub(() => ({ status: 410 })).http, clock }),
        config,
      ),
    ).toBe("permanent");
    const real = createOutboundHttp({ policy: createAddressPolicy() });
    expect(
      await failure(createWebhookAdapter({ http: real, clock }), {
        url: "http://127.0.0.1:9/hook",
        secret: "s".repeat(32),
      }),
    ).toBe("permanent");
  });
});

describe("Discord adapter", () => {
  const url = "https://discord.com/api/webhooks/123456/abc-DEF_1";

  it("accepts only Discord webhook URLs", () => {
    const adapter = createDiscordAdapter({ http: stub().http });
    expect(() =>
      adapter.parseConfig({ url: "https://evil.example.com/api/webhooks/1/x" }),
    ).toThrow();
    expect(adapter.parseConfig({ url })).toEqual({ url });
  });

  it("posts a colored embed, returns the message ID, and edits it on follow-ups", async () => {
    const provider = stub(() => ({ body: '{"id":"998877"}' }));
    const adapter = createDiscordAdapter({ http: provider.http });
    const sent = await adapter.send({ url }, adapter.render(event()), meta());
    expect(sent.providerRef).toBe("998877");
    expect(provider.requests[0]?.url).toBe(`${url}?wait=true`);
    expect(provider.body(0).embeds[0]).toMatchObject({
      title: "[Critical] #482 Checkout API is down",
      url: "https://app.example.com/w/acme/incidents/482",
      color: 0xe5484d,
    });

    await adapter.update!({ url }, "998877", adapter.render(event("resolved")));
    expect(provider.requests[1]).toMatchObject({ method: "PATCH", url: `${url}/messages/998877` });
    expect(provider.body(1).embeds[0].color).toBe(0x30a46c);
  });

  it("treats a deleted webhook as permanent and rate limits as transient", async () => {
    expect(
      await failure(createDiscordAdapter({ http: stub(() => ({ status: 404 })).http }), { url }),
    ).toBe("permanent");
    expect(
      await failure(createDiscordAdapter({ http: stub(() => ({ status: 429 })).http }), { url }),
    ).toBe("transient");
  });
});

describe("Teams adapter", () => {
  const url =
    "https://prod-12.westeurope.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=x";

  it("accepts only Workflows webhook URLs", () => {
    const adapter = createTeamsAdapter({ http: stub().http });
    expect(() => adapter.parseConfig({ url: "https://example.com/hook" })).toThrow();
    expect(() => adapter.parseConfig({ url: url.replace("https", "http") })).toThrow();
    expect(adapter.parseConfig({ url })).toEqual({ url });
  });

  it("posts an Adaptive Card with the facts and an Open incident button", async () => {
    const provider = stub(() => ({ status: 202 }));
    const adapter = createTeamsAdapter({ http: provider.http });
    await adapter.send({ url }, adapter.render(event()), meta());
    const card = provider.body(0).attachments[0];
    expect(card.contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(card.content.body[0]).toMatchObject({
      text: "[Critical] #482 Checkout API is down",
      color: "attention",
    });
    expect(card.content.body[1].facts).toContainEqual({
      title: "Regions",
      value: "eu-central, us-east",
    });
    expect(card.content.actions).toEqual([
      {
        type: "Action.OpenUrl",
        title: "Open incident",
        url: "https://app.example.com/w/acme/incidents/482",
      },
    ]);
  });

  it("marks a deleted flow permanent and throttling transient", async () => {
    expect(
      await failure(createTeamsAdapter({ http: stub(() => ({ status: 404 })).http }), { url }),
    ).toBe("permanent");
    expect(
      await failure(createTeamsAdapter({ http: stub(() => ({ status: 429 })).http }), { url }),
    ).toBe("transient");
  });
});

describe("Slack adapter", () => {
  const config = {
    installationId: "0190a000-0000-7000-8000-0000000000aa",
    channelId: "C0123ABC",
    channelName: "alerts",
  };
  const make = (
    answer: (req: OutboundRequest) => Partial<OutboundResponse>,
    token: string | null = "xoxb-1",
  ) => {
    const provider = stub(answer);
    const adapter = createSlackAdapter({
      http: provider.http,
      tokenFor: async () => token ?? undefined,
      ownsInstallation: async (_id, workspaceId) => workspaceId === "mine",
    });
    return { provider, adapter };
  };

  it("posts Block Kit with the bot token and threads follow-ups", async () => {
    const { provider, adapter } = make(() => ({ body: '{"ok":true,"ts":"1700000000.000100"}' }));
    const first = await adapter.send(config, adapter.render(event()), meta());
    expect(first.providerRef).toBe("C0123ABC:1700000000.000100");
    expect(provider.requests[0]).toMatchObject({
      url: "https://slack.com/api/chat.postMessage",
      headers: expect.objectContaining({ authorization: "Bearer xoxb-1" }),
    });
    const body = provider.body(0);
    expect(body).toMatchObject({
      channel: "C0123ABC",
      text: "[Critical] #482 Checkout API is down",
    });
    expect(body.blocks[0].text.text).toBe("🔴 DOWN · Checkout API");
    expect(body.thread_ts).toBeUndefined();

    await adapter.send(
      config,
      adapter.render(event("acknowledged", "Sara")),
      meta(first.providerRef!),
    );
    expect(provider.body(1).thread_ts).toBe("1700000000.000100");
    await adapter.update!(config, first.providerRef!, adapter.render(event("resolved")));
    expect(provider.requests[2]?.url).toBe("https://slack.com/api/chat.update");
    expect(provider.body(2)).toMatchObject({ channel: "C0123ABC", ts: "1700000000.000100" });
  });

  it("classifies Slack errors", async () => {
    expect(
      await failure(
        make(() => ({ body: '{"ok":false,"error":"channel_not_found"}' })).adapter,
        config,
      ),
    ).toBe("permanent");
    expect(
      await failure(make(() => ({ body: '{"ok":false,"error":"token_revoked"}' })).adapter, config),
    ).toBe("permanent");
    expect(
      await failure(
        make(() => ({ status: 429, body: '{"ok":false,"error":"ratelimited"}' })).adapter,
        config,
      ),
    ).toBe("transient");
    expect(
      await failure(
        make(() => ({ body: '{"ok":false,"error":"internal_error"}' })).adapter,
        config,
      ),
    ).toBe("transient");
    expect(await failure(make(() => ({}), null).adapter, config)).toBe("permanent");
  });

  it("only accepts installations of the same workspace", async () => {
    const { adapter } = make(() => ({}));
    await expect(
      adapter.prepare!(config, { workspaceId: "mine", previous: undefined }),
    ).resolves.toEqual(config);
    await expect(
      adapter.prepare!(config, { workspaceId: "other", previous: undefined }),
    ).rejects.toThrow(/doesn't belong/);
  });
});

describe("Telegram adapter", () => {
  const make = (answer: (req: OutboundRequest) => Partial<OutboundResponse>) => {
    const provider = stub(answer);
    const adapter = createTelegramAdapter({
      api: createTelegramApi({ http: provider.http, botToken: "123:abc" }),
    });
    return { provider, adapter };
  };
  const linked = { chatId: "-100200", chatTitle: "Ops" };

  it("sends to the linked chat and replies to the first message on follow-ups", async () => {
    const { provider, adapter } = make(() => ({ body: '{"ok":true,"result":{"message_id":41}}' }));
    const first = await adapter.send(linked, adapter.render(event()), meta());
    expect(first.providerRef).toBe("-100200:41");
    expect(provider.requests[0]?.url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    expect(provider.body(0)).toMatchObject({ chat_id: "-100200" });
    expect(provider.body(0).text).toContain("#482 Checkout API is down");

    await adapter.send(linked, adapter.render(event("resolved")), meta("-100200:41"));
    expect(provider.body(1).reply_parameters).toEqual({
      message_id: 41,
      allow_sending_without_reply: true,
    });
  });

  it("refuses to send before the chat is linked, and never lets the API set the chat", async () => {
    const { adapter } = make(() => ({}));
    const created = await adapter.prepare!(
      { chatId: "999" },
      { workspaceId: "w", previous: undefined },
    );
    expect(created).toEqual({ chatId: null, chatTitle: null });
    expect(await failure(adapter, created)).toBe("permanent");
    const kept = await adapter.prepare!({ chatId: "999" }, { workspaceId: "w", previous: linked });
    expect(kept).toEqual(linked);
  });

  it("treats a blocked bot as permanent and ignores 'message is not modified'", async () => {
    expect(
      await failure(
        make(() => ({
          status: 403,
          body: '{"ok":false,"description":"Forbidden: bot was blocked"}',
        })).adapter,
        linked,
      ),
    ).toBe("permanent");
    expect(await failure(make(() => ({ status: 429, body: '{"ok":false}' })).adapter, linked)).toBe(
      "transient",
    );
    const { adapter } = make(() => ({
      status: 400,
      body: '{"ok":false,"description":"Bad Request: message is not modified"}',
    }));
    await expect(
      adapter.update!(linked, "-100200:41", adapter.render(event())),
    ).resolves.toBeUndefined();
  });
});

describe("failure explanations in alerts", () => {
  it("every channel shows the likely cause and the first check", async () => {
    const plain = createTeamsAdapter({ http: stub().http }).render(event());
    expect(plain.text).toContain("Likely cause: Gateway error (HTTP 502)");
    expect(plain.text).toContain("Check first: Check that the application servers");

    const slack = createSlackAdapter({
      http: stub().http,
      tokenFor: async () => "t",
      ownsInstallation: async () => true,
    }).render(event());
    expect(JSON.stringify(slack.body)).toContain("*Likely cause:* Gateway error (HTTP 502)");

    const card = createTeamsAdapter({ http: stub().http }).render(event()).body as {
      attachments: Array<{ content: { body: Array<{ facts?: Array<{ title: string }> }> } }>;
    };
    expect(card.attachments[0]?.content.body[1]?.facts?.map((f) => f.title)).toContain(
      "Likely cause",
    );

    const hook = createWebhookAdapter({
      http: stub().http,
      clock: createFakeClock(),
    }).render(event()).body as { explanation: { headline: string } };
    expect(hook.explanation.headline).toMatch(/^Gateway error/);

    const resolved = createTeamsAdapter({ http: stub().http }).render(event("resolved"));
    expect(resolved.text).not.toContain("Likely cause");
  });
});
