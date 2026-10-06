/*
 * P4-T02c through the real API with the messaging provider mocked at the HTTP layer: SMS and voice
 * contact methods verified by a code that costs alert credits, and a high-urgency incident that
 * emails at once, texts after 2 minutes and calls after 5, each charged, none sent after an
 * acknowledgement.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContactMethodView, NotificationRulesView } from "@app/shared";
import { createFakeClock } from "../core/clock.js";
import { createWorkspaceScope } from "../core/workspace-scope.js";
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
import type { AlertingModule } from "../modules/alerting/index.js";
import type { BillingModule } from "../modules/billing/index.js";
import type { CreditsModule } from "../modules/credits/index.js";
import type { MonitorsModule } from "../modules/monitors/index.js";
import type { WorkspacesModule } from "../modules/workspaces/index.js";

const TWILIO_ENV = {
  TWILIO_ACCOUNT_SID: `AC${"0123456789abcdef".repeat(2)}`,
  TWILIO_AUTH_TOKEN: "twilio-test-auth-token-0123456789",
  TWILIO_SMS_FROM: "+15005550006",
  TWILIO_VOICE_FROM: "+15005550006",
};
const PHONE = "+14155550188";
const MINUTE = 60_000;

const http = stubHttp((req) =>
  req.url.startsWith("https://api.twilio.com/")
    ? { status: 201, body: JSON.stringify({ sid: `SM${http.requests.length}` }) }
    : undefined,
);
const twilio = (path: string) =>
  http.requests
    .filter((r) => r.url.endsWith(path))
    .map((r) => Object.fromEntries(new URLSearchParams(r.body ?? "")));

const clock = createFakeClock(new Date());
const paddle = fakePaddleApi(clock);
let ctx: BillingApp;
let alerting: AlertingModule;
let owner: Awaited<ReturnType<typeof signUpWithWorkspace>>;

const base = () => `/api/w/${owner.workspaceId}`;
const scope = () => createWorkspaceScope({ workspaceId: owner.workspaceId });
const credits = async () => (await ctx.credits.service.state(scope())).total;
const methods = async () =>
  (await get(owner.agent, `${base()}/me/contact-methods`)).body.data as ContactMethodView[];

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
  alerting = moduleOf<AlertingModule>("alerting");
  owner = await signUpWithWorkspace(ctx, "phonecontact");
}, 120_000);

afterAll(async () => {
  await ctx.container.close();
});

describe("phone contact methods", () => {
  it("adds nothing and sends nothing while the workspace has no credits", async () => {
    const res = await post(owner.agent, `${base()}/me/contact-methods`, {
      type: "sms",
      address: PHONE,
    });
    expect(res.status).toBe(402);
    expect(twilio("/Messages.json")).toHaveLength(0);
    expect((await methods()).map((m) => m.type)).toEqual(["email"]);
  });

  it("verifies an SMS method with the texted code, for one credit", async () => {
    await subscribeWorkspace(ctx, paddle, clock, owner, {
      priceId: PRICES.starterMonth,
      plan: "starter",
    });
    await ctx.credits.service.grantDue(owner.workspaceId);
    const before = await credits();

    const added = await post(owner.agent, `${base()}/me/contact-methods`, {
      type: "sms",
      address: "+1 (415) 555-0188",
    });
    expect(added.status, added.text).toBe(201);
    expect(added.body).toMatchObject({ type: "sms", address: PHONE, verified: false });
    expect(await credits()).toBe(before - 1);
    const text = twilio("/Messages.json").at(-1);
    expect(text?.To).toBe(PHONE);
    const code = /code: (\d{6})/.exec(text?.Body ?? "")?.[1] ?? "";

    const wrong = await post(owner.agent, `${base()}/me/contact-methods/${added.body.id}/confirm`, {
      code: code === "000000" ? "000001" : "000000",
    });
    expect(wrong.status).toBe(400);
    const confirmed = await post(
      owner.agent,
      `${base()}/me/contact-methods/${added.body.id}/confirm`,
      { code },
    );
    expect(confirmed.status, confirmed.text).toBe(200);
    expect(confirmed.body.verified).toBe(true);
  });

  it("makes the same number ready for calls at once, with no second code", async () => {
    const sent = twilio("/Messages.json").length;
    const before = await credits();
    const added = await post(owner.agent, `${base()}/me/contact-methods`, {
      type: "voice",
      address: PHONE,
    });
    expect(added.status, added.text).toBe(201);
    expect(added.body.verified).toBe(true);
    expect(twilio("/Messages.json")).toHaveLength(sent);
    expect(await credits()).toBe(before);
  });

  it("gives phone methods the default rules: SMS after 2 minutes, a call after 5, high urgency only", async () => {
    const all = await methods();
    const id = (type: string) => all.find((m) => m.type === type)?.id;
    const rules = (await get(owner.agent, `${base()}/me/notification-rules`))
      .body as NotificationRulesView;
    expect(rules.high).toEqual([
      { contactMethodId: id("email"), delayMinutes: 0 },
      { contactMethodId: id("sms"), delayMinutes: 2 },
      { contactMethodId: id("voice"), delayMinutes: 5 },
    ]);
    expect(rules.low).toEqual([{ contactMethodId: id("email"), delayMinutes: 0 }]);
  });
});

describe("a high-urgency incident sent to a person with a phone", () => {
  async function page(title: string) {
    const created = await post(owner.agent, `${base()}/incidents`, { title, severity: "critical" });
    expect(created.status, created.text).toBe(201);
    const incident = { id: created.body.id as string, number: created.body.number as number };
    const start = clock.now().getTime();
    const planned = await alerting.service.notifyUser({
      incidentId: incident.id,
      eventKey: `page.${incident.id}`,
      userId: owner.userId,
    });
    const deliveries = (await alerting.service.deliveriesFor(incident.id)).filter(
      (d) => d.userId !== null,
    );
    const of = (type: string) => deliveries.find((d) => d.contactType === type);
    return { incident, start, planned, of };
  }

  it("emails at once, texts at 2 minutes and calls at 5, charging each paid message", async () => {
    const { start, planned, of } = await page("Checkout down");
    expect(planned).toBe(3);
    expect(of("email")?.dueAt).toBeNull();
    expect(Date.parse(of("sms")?.dueAt ?? "")).toBe(start + 2 * MINUTE);
    expect(Date.parse(of("voice")?.dueAt ?? "")).toBe(start + 5 * MINUTE);

    const before = await credits();
    const texts = twilio("/Messages.json").length;
    const calls = twilio("/Calls.json").length;
    expect(await alerting.service.deliver(of("email")?.id ?? "")).toBe("sent");
    expect(await credits()).toBe(before);

    clock.advance(2 * MINUTE);
    expect(await alerting.service.deliver(of("sms")?.id ?? "")).toBe("sent");
    expect(twilio("/Messages.json")).toHaveLength(texts + 1);
    expect(twilio("/Messages.json").at(-1)?.Body).toContain("Checkout down");
    expect(await credits()).toBe(before - 1);

    clock.advance(3 * MINUTE);
    expect(await alerting.service.deliver(of("voice")?.id ?? "")).toBe("sent");
    expect(twilio("/Calls.json")).toHaveLength(calls + 1);
    expect(twilio("/Calls.json").at(-1)?.To).toBe(PHONE);
    expect(await credits()).toBe(before - 3);
  });

  it("sends and charges nothing after an acknowledgement", async () => {
    const { incident, of } = await page("Search slow");
    expect(await alerting.service.deliver(of("email")?.id ?? "")).toBe("sent");
    clock.advance(MINUTE);
    const ack = await post(owner.agent, `${base()}/incidents/${incident.number}/acknowledge`);
    expect(ack.status, ack.text).toBe(200);

    const before = await credits();
    const texts = twilio("/Messages.json").length;
    const calls = twilio("/Calls.json").length;
    clock.advance(MINUTE);
    expect(await alerting.service.deliver(of("sms")?.id ?? "")).toBe("skipped");
    clock.advance(3 * MINUTE);
    expect(await alerting.service.deliver(of("voice")?.id ?? "")).toBe("skipped");
    expect(twilio("/Messages.json")).toHaveLength(texts);
    expect(twilio("/Calls.json")).toHaveLength(calls);
    expect(await credits()).toBe(before);
  });
});
