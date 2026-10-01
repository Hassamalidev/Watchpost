/*
 * P3-T05a through the real API with the messaging provider mocked at the HTTP layer: what a number
 * costs, verification by code, SMS and voice alerts charged in credits (and never sent without them),
 * credits returned when a send fails, and signed replies that acknowledge and resolve incidents.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createFakeClock } from "../core/clock.js";
import { createWorkspaceScope } from "../core/workspace-scope.js";
import { twilioSignature } from "../infra/messaging/index.js";
import {
  PADDLE_ENV,
  PRICES,
  fakePaddleApi,
  get,
  post,
  signUpWithWorkspace,
  subscribeWorkspace,
  type BillingApp,
} from "./helpers/billing.js";
import { buildContainerApp, stubHttp } from "./helpers/container-app.js";
import type { BillingModule } from "../modules/billing/index.js";
import type { CreditsModule } from "../modules/credits/index.js";
import type { IncidentsModule } from "../modules/incidents/index.js";
import type { MonitorsModule } from "../modules/monitors/index.js";
import type { WorkspacesModule } from "../modules/workspaces/index.js";
import {
  ChannelDeliveryError,
  type AlertEvent,
  type ChannelsModule,
} from "../modules/channels/index.js";

const AUTH_TOKEN = "twilio-test-auth-token-0123456789";
const TWILIO_ENV = {
  TWILIO_ACCOUNT_SID: `AC${"0123456789abcdef".repeat(2)}`,
  TWILIO_AUTH_TOKEN: AUTH_TOKEN,
  TWILIO_SMS_FROM: "+15005550006",
  TWILIO_VOICE_FROM: "+15005550006",
};
const API = "http://localhost:4000";
const PHONE = "+14155550123";

/* What the fake provider answers next; reset after each use. */
let providerFails: { status: number; code: number; message: string } | null = null;
const http = stubHttp((req) => {
  if (!req.url.startsWith("https://api.twilio.com/")) return undefined;
  if (providerFails !== null) {
    const failure = providerFails;
    return { status: failure.status, body: JSON.stringify(failure) };
  }
  return { status: 201, body: JSON.stringify({ sid: `SM${http.requests.length}` }) };
});
const twilioCalls = (path: string) =>
  http.requests
    .filter((r) => r.url.endsWith(path))
    .map((r) => Object.fromEntries(new URLSearchParams(r.body ?? "")));

const clock = createFakeClock(new Date());
const paddle = fakePaddleApi(clock);
let ctx: BillingApp;
let channels: ChannelsModule;
let incidents: IncidentsModule;
let owner: Awaited<ReturnType<typeof signUpWithWorkspace>>;
let smsChannelId: string;

const scope = () => createWorkspaceScope({ workspaceId: owner.workspaceId });
const credits = async () => (await ctx.credits.service.state(scope())).total;

async function openIncident(title: string) {
  return incidents.service.create(
    createWorkspaceScope({
      workspaceId: owner.workspaceId,
      actorUserId: owner.userId,
      role: "owner",
    }),
    { title, severity: "high" },
  );
}

function triggered(incident: { id: string; number: number; title: string }): AlertEvent {
  const now = clock.now().toISOString();
  return {
    kind: "triggered",
    workspace: { id: owner.workspaceId, name: "Phone Co" },
    incident: {
      id: incident.id,
      number: incident.number,
      title: incident.title,
      severity: "high",
      status: "triggered",
      causeCode: null,
      failingRegions: ["eu-central", "us-east"],
      monitorName: "API Prod",
      startedAt: now,
      resolvedAt: null,
      durationSeconds: 0,
      url: `http://localhost:3000/w/${owner.workspaceId}/incidents/${incident.id}`,
    },
    actor: null,
    at: now,
    explanation: { headline: "HTTP 502", detail: "", nextSteps: [] },
  };
}

function signedForm(path: string, fields: Record<string, string>, token = AUTH_TOKEN) {
  return request(ctx.app)
    .post(path)
    .type("form")
    .set("X-Twilio-Signature", twilioSignature(token, `${API}${path}`, fields))
    .send(fields);
}

beforeAll(async () => {
  const built = buildContainerApp({
    authRateLimit: false,
    clock,
    http,
    env: { ...PADDLE_ENV, ...TWILIO_ENV },
    paddleApi: paddle.api,
  });
  const moduleOf = <T>(name: string) => built.container.modules.find((m) => m.name === name) as T;
  ctx = {
    ...built,
    billing: moduleOf<BillingModule>("billing"),
    credits: moduleOf<CreditsModule>("credits"),
    monitors: moduleOf<MonitorsModule>("monitors"),
    workspaces: moduleOf<WorkspacesModule>("workspaces"),
  };
  channels = moduleOf<ChannelsModule>("channels");
  incidents = moduleOf<IncidentsModule>("incidents");
  owner = await signUpWithWorkspace(ctx, "phone");
});

afterAll(async () => {
  await ctx.container.close();
});

describe("phone numbers", () => {
  const base = () => `/api/w/${owner.workspaceId}/phone-numbers`;

  it("shows what a number costs before it is enabled, and refuses countries we don't serve", async () => {
    const cost = await get(owner.agent, `${base()}/cost?phone=${encodeURIComponent(PHONE)}`);
    expect(cost.body).toEqual({
      phone: PHONE,
      country: "US",
      smsCredits: 1,
      voiceCredits: 2,
      sms: true,
      voice: true,
    });
    const pakistan = await get(owner.agent, `${base()}/cost?phone=%2B923001234567`);
    expect(pakistan.body).toMatchObject({ country: "PK", smsCredits: 17, voiceCredits: 13 });
    const unserved = await get(owner.agent, `${base()}/cost?phone=%2B8613800138000`);
    expect(unserved.status).toBe(400);
    /* A Caribbean number shares +1 with the US but costs many times more. */
    expect((await get(owner.agent, `${base()}/cost?phone=%2B18765550123`)).status).toBe(400);
  });

  it("sends no code without credits: an unpaid workspace spends nothing", async () => {
    const res = await post(owner.agent, `${base()}/codes`, { phone: PHONE });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe("quota_exceeded");
    expect(twilioCalls("/Messages.json")).toHaveLength(0);
  });

  it("verifies a number with the code it was sent, charging one credit for the SMS", async () => {
    await subscribeWorkspace(ctx, paddle, clock, owner, {
      priceId: PRICES.starterMonth,
      plan: "starter",
    });
    await ctx.credits.service.grantDue(owner.workspaceId);
    expect(await credits()).toBe(25);

    const unverified = await post(owner.agent, `/api/w/${owner.workspaceId}/channels`, {
      type: "sms",
      name: "On-call phone",
      config: { phone: PHONE },
    });
    expect(unverified.status).toBe(400);
    expect(unverified.body.errors).toEqual([
      { path: "body.config.phone", message: expect.stringContaining("Verify this number first") },
    ]);

    const sent = await post(owner.agent, `${base()}/codes`, { phone: "+1 (415) 555-0123" });
    expect(sent.status, sent.text).toBe(201);
    expect(await credits()).toBe(24);
    const [message] = twilioCalls("/Messages.json").slice(-1);
    expect(message).toMatchObject({ To: PHONE, From: TWILIO_ENV.TWILIO_SMS_FROM });
    const code = /code: (\d{6})/.exec(message?.Body ?? "")?.[1] ?? "";
    expect(code).toHaveLength(6);

    const wrong = await post(owner.agent, `${base()}/confirm`, {
      phone: PHONE,
      code: code === "000000" ? "000001" : "000000",
    });
    expect(wrong.status).toBe(400);
    const right = await post(owner.agent, `${base()}/confirm`, { phone: PHONE, code });
    expect(right.body).toEqual({ verified: true });

    const created = await post(owner.agent, `/api/w/${owner.workspaceId}/channels`, {
      type: "sms",
      name: "On-call phone",
      config: { phone: PHONE },
    });
    expect(created.status, created.text).toBe(201);
    expect(created.body.config).toEqual({ phone: PHONE });
    smsChannelId = created.body.id;
  });

  it("limits how many codes go to one number in an hour", async () => {
    const other = "+14155550199";
    for (let i = 0; i < 3; i += 1) {
      expect((await post(owner.agent, `${base()}/codes`, { phone: other })).status).toBe(201);
    }
    expect((await post(owner.agent, `${base()}/codes`, { phone: other })).status).toBe(429);
    expect(await credits()).toBe(21);
  });

  it("returns the credit when the code can't be sent", async () => {
    providerFails = { status: 400, code: 21211, message: "Invalid 'To' Phone Number" };
    const res = await post(owner.agent, `${base()}/codes`, { phone: "+14155550177" });
    providerFails = null;
    expect(res.status).toBe(502);
    expect(await credits()).toBe(21);
  });
});

describe("SMS alerts", () => {
  it("lists SMS and voice as available on a server with a messaging provider", async () => {
    const types = await get(owner.agent, `/api/w/${owner.workspaceId}/channels/types`);
    const byType = new Map(
      (types.body.data as Array<{ type: string; available: boolean }>).map((t) => [
        t.type,
        t.available,
      ]),
    );
    expect(byType.get("sms")).toBe(true);
    expect(byType.get("voice")).toBe(true);
  });

  it("Send test costs one credit and gives it back when the provider refuses", async () => {
    const ok = await post(owner.agent, `/api/w/${owner.workspaceId}/channels/${smsChannelId}/test`);
    expect(ok.body).toEqual({ ok: true });
    expect(twilioCalls("/Messages.json").at(-1)?.Body).toContain("test alert");
    expect(await credits()).toBe(20);

    providerFails = {
      status: 400,
      code: 21610,
      message: "Attempt to send to unsubscribed recipient",
    };
    await post(owner.agent, `/api/w/${owner.workspaceId}/channels/${smsChannelId}/test`);
    providerFails = null;
    expect(await credits()).toBe(20);
  });

  it("an alert is one segment with reply codes, charged once however often it is retried", async () => {
    const incident = await openIncident("API Prod is down");
    const event = triggered(incident);
    const key = `delivery.${incident.id}`;
    await channels.service.deliver({ channelId: smsChannelId, event, idempotencyKey: key });
    await channels.service.deliver({ channelId: smsChannelId, event, idempotencyKey: key });
    expect(await credits()).toBe(19);
    const body = twilioCalls("/Messages.json").at(-1)?.Body ?? "";
    expect(body).toBe(
      `Watchpost: DOWN API Prod (HTTP 502, 2 regions) #${incident.number}. Reply 1=ack 2=resolve`,
    );
    expect(body.length).toBeLessThanOrEqual(160);
  });

  it("a reply needs the provider's signature", async () => {
    const fields = { From: PHONE, Body: "1" };
    const unsigned = await request(ctx.app)
      .post("/api/webhooks/twilio/sms")
      .type("form")
      .send(fields);
    expect(unsigned.status).toBe(401);
    const forged = await signedForm(
      "/api/webhooks/twilio/sms",
      fields,
      "not-the-auth-token-0123456789",
    );
    expect(forged.status).toBe(401);
  });

  it('replying "1" acknowledges the last alert and "2" resolves it', async () => {
    const incident = await openIncident("Checkout is down");
    await channels.service.deliver({
      channelId: smsChannelId,
      event: triggered(incident),
      idempotencyKey: `delivery.${incident.id}`,
    });

    const ack = await signedForm("/api/webhooks/twilio/sms", { From: PHONE, Body: " 1 " });
    expect(ack.status).toBe(200);
    expect(ack.headers["content-type"]).toContain("text/xml");
    expect(ack.text).toContain(`#${incident.number} acknowledged.`);
    const acked = await incidents.service.get(scope(), incident.id);
    expect(acked.status).toBe("acknowledged");
    expect(acked.acknowledgedAt).not.toBeNull();

    const again = await signedForm("/api/webhooks/twilio/sms", { From: PHONE, Body: "1" });
    expect(again.text).toContain("already acknowledged");

    const resolve = await signedForm("/api/webhooks/twilio/sms", { From: PHONE, Body: "2" });
    expect(resolve.text).toContain(`#${incident.number} resolved.`);
    expect((await incidents.service.get(scope(), incident.id)).status).toBe("resolved");

    const help = await signedForm("/api/webhooks/twilio/sms", { From: PHONE, Body: "what?" });
    expect(help.text).toContain("reply 1 to acknowledge");
    const stranger = await signedForm("/api/webhooks/twilio/sms", {
      From: "+14155550000",
      Body: "1",
    });
    expect(stranger.text).toContain("no alert for this number");
  });
});

describe("voice alerts", () => {
  let voiceChannelId: string;

  it("calls a verified number, reads the alert and costs two credits", async () => {
    const created = await post(owner.agent, `/api/w/${owner.workspaceId}/channels`, {
      type: "voice",
      name: "On-call phone (call)",
      config: { phone: PHONE },
    });
    expect(created.status, created.text).toBe(201);
    voiceChannelId = created.body.id;

    const before = await credits();
    const incident = await openIncident("Database is down");
    await channels.service.deliver({
      channelId: voiceChannelId,
      event: triggered(incident),
      idempotencyKey: `delivery.voice.${incident.id}`,
    });
    expect(await credits()).toBe(before - 2);
    const call = twilioCalls("/Calls.json").at(-1);
    expect(call).toMatchObject({ To: PHONE, From: TWILIO_ENV.TWILIO_VOICE_FROM, TimeLimit: "60" });
    expect(call?.Twiml).toContain("Press 1 to acknowledge.");
    expect(call?.Twiml).toContain(`${API}/api/webhooks/twilio/voice?incident=${incident.id}`);

    /* No call is placed to say the incident was acknowledged, and nothing is charged. */
    const calls = twilioCalls("/Calls.json").length;
    const skipped = await channels.service.deliver({
      channelId: voiceChannelId,
      event: { ...triggered(incident), kind: "acknowledged" },
      idempotencyKey: `delivery.voice.ack.${incident.id}`,
    });
    expect(skipped.skipped).toBeDefined();
    expect(twilioCalls("/Calls.json")).toHaveLength(calls);
    expect(await credits()).toBe(before - 2);

    const path = `/api/webhooks/twilio/voice?incident=${incident.id}`;
    const pressed = await signedForm(path, { To: PHONE, Digits: "1" });
    expect(pressed.status).toBe(200);
    expect(pressed.text).toContain("acknowledged");
    expect((await incidents.service.get(scope(), incident.id)).status).toBe("acknowledged");
    /* On a call, 2 does nothing: resolving takes more than a mispressed key. */
    const two = await signedForm(path, { To: PHONE, Digits: "2" });
    expect(two.text).toContain("Goodbye");
    expect((await incidents.service.get(scope(), incident.id)).status).toBe("acknowledged");
  });

  it("a keypress in a test call acts on nothing", async () => {
    const incident = await openIncident("Still open");
    await channels.service.deliver({
      channelId: voiceChannelId,
      event: triggered(incident),
      idempotencyKey: `delivery.voice.${incident.id}`,
    });
    const res = await signedForm("/api/webhooks/twilio/voice?test=1", { To: PHONE, Digits: "1" });
    expect(res.text).toContain("The test worked");
    expect((await incidents.service.get(scope(), incident.id)).status).toBe("triggered");
    /* The signature covers the URL, so the incident in it can't be swapped. */
    const swapped = await request(ctx.app)
      .post(`/api/webhooks/twilio/voice?incident=${incident.id}`)
      .type("form")
      .set(
        "X-Twilio-Signature",
        twilioSignature(AUTH_TOKEN, `${API}/api/webhooks/twilio/voice?test=1`, {
          To: PHONE,
          Digits: "1",
        }),
      )
      .send({ To: PHONE, Digits: "1" });
    expect(swapped.status).toBe(401);
  });
});

describe("credits", () => {
  it("nothing is sent once the credits are gone", async () => {
    const left = await credits();
    await ctx.credits.service.charge(scope(), { credits: left, refId: "drain-for-test" });
    const sentBefore = twilioCalls("/Messages.json").length;
    const incident = await openIncident("No credits left");
    const attempt = channels.service.deliver({
      channelId: smsChannelId,
      event: triggered(incident),
      idempotencyKey: `delivery.${incident.id}`,
    });
    await expect(attempt).rejects.toBeInstanceOf(ChannelDeliveryError);
    await expect(attempt).rejects.toMatchObject({
      permanent: true,
      message: expect.stringContaining("costs 1 alert credit and the workspace has 0"),
    });
    expect(twilioCalls("/Messages.json")).toHaveLength(sentBefore);
  });

  it("a charge that was given back can't pay for a later send", async () => {
    const service = ctx.credits.service;
    await service.refundCharge(scope(), "drain-for-test");
    const before = await credits();
    expect(await service.charge(scope(), { credits: 1, refId: "delivery.x" })).toMatchObject({
      ok: true,
      alreadyCharged: false,
    });
    expect(await service.refundCharge(scope(), "delivery.x")).toBe(1);
    expect(await service.refundCharge(scope(), "delivery.x")).toBe(0);
    expect(await credits()).toBe(before);
    expect(await service.charge(scope(), { credits: 1, refId: "delivery.x" })).toMatchObject({
      ok: false,
    });
    expect(await credits()).toBe(before);
  });
});
