/*
 * P4-T08 against the real container with the push service mocked at the HTTP layer: a device is
 * added as a contact method, an incident reaches it as an encrypted notification that only its
 * browser can read, the notification's Acknowledge link acknowledges without a session, and a
 * device whose browser dropped the subscription is forgotten.
 */
import { createDecipheriv, createECDH, createHmac, randomBytes } from "node:crypto";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContactMethodView, NotificationRulesView } from "@app/shared";
import { generateVapidKeys } from "../infra/webpush.js";
import type { AlertingModule } from "../modules/alerting/index.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  signUpVerified,
  stubHttp,
} from "./helpers/container-app.js";

const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer, length: number) => {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  return createHmac("sha256", prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest()
    .subarray(0, length);
};

/* The browser side of a subscription. */
function device(endpoint: string) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    endpoint,
    keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") },
    read(message: Buffer): Record<string, unknown> {
      const salt = message.subarray(0, 16);
      const idLength = message[20] as number;
      const serverPublic = message.subarray(21, 21 + idLength);
      const body = message.subarray(21 + idLength);
      const ikm = hkdf(
        auth,
        ecdh.computeSecret(serverPublic),
        Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), serverPublic]),
        32,
      );
      const decipher = createDecipheriv(
        "aes-128-gcm",
        hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16),
        hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12),
      );
      decipher.setAuthTag(body.subarray(body.length - 16));
      const plain = Buffer.concat([
        decipher.update(body.subarray(0, body.length - 16)),
        decipher.final(),
      ]);
      return JSON.parse(plain.subarray(0, plain.length - 1).toString("utf8")) as Record<
        string,
        unknown
      >;
    },
  };
}

const vapid = generateVapidKeys();
const run = randomBytes(4).toString("hex");
const phone = device(`https://fcm.googleapis.com/fcm/send/phone-${run}`);
const oldLaptop = device(`https://updates.push.services.mozilla.com/wpush/v2/gone-${run}`);
const http = stubHttp((req) => {
  if (req.url === oldLaptop.endpoint) return { status: 410, body: "" };
  if (req.url === phone.endpoint) return { status: 201, body: "" };
  return undefined;
});
const ctx = buildContainerApp({
  authRateLimit: false,
  http,
  env: {
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: "mailto:ops@example.com",
  },
});

let owner: TestAgent;
let ws = "";
let userId = "";
const alerting = () =>
  (ctx.container.modules.find((m) => m.name === "alerting") as AlertingModule).service;
const api = (method: "get" | "post" | "delete", path: string) =>
  owner[method](`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN);
const methods = async () =>
  (await api("get", "/me/contact-methods")).body.data as ContactMethodView[];

beforeAll(async () => {
  owner = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `push-${run}@example.com`);
  const created = await owner
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "Push Co", slug: `push-${run}` });
  ws = created.body.id as string;
  userId = (await api("get", "/members")).body.data[0].userId as string;
}, 120_000);

afterAll(async () => {
  await ctx.container.close();
});

describe("a device as a contact method", () => {
  it("tells the browser which key to subscribe with", async () => {
    const config = await api("get", "/me/push");
    expect(config.body).toEqual({ available: true, publicKey: vapid.publicKey });
  });

  it("is ready at once, with rules for both urgencies, and never shows its keys", async () => {
    const added = await api("post", "/me/contact-methods").send({
      type: "push",
      address: phone.endpoint,
      label: "Chrome on Android",
      push: phone.keys,
    });
    expect(added.status, added.text).toBe(201);
    expect(added.body).toMatchObject({ type: "push", verified: true, label: "Chrome on Android" });
    expect(JSON.stringify(added.body)).not.toContain(phone.keys.auth);

    const rules = (await api("get", "/me/notification-rules")).body as NotificationRulesView;
    expect(rules.high).toContainEqual({ contactMethodId: added.body.id, delayMinutes: 0 });
    expect(rules.low).toContainEqual({ contactMethodId: added.body.id, delayMinutes: 0 });

    const bad = await api("post", "/me/contact-methods").send({
      type: "push",
      address: "http://insecure.example.com/push",
      push: phone.keys,
    });
    expect(bad.status).toBe(400);
    const noKeys = await api("post", "/me/contact-methods").send({
      type: "push",
      address: `${phone.endpoint}-2`,
    });
    expect(noKeys.status).toBe(400);
  });
});

describe("an incident on the device", () => {
  it("arrives encrypted, with a link that acknowledges without signing in", async () => {
    const created = await api("post", "/incidents").send({
      title: "Checkout down",
      severity: "critical",
    });
    const incident = { id: created.body.id as string, number: created.body.number as number };
    await alerting().notifyUser({
      incidentId: incident.id,
      eventKey: `page.${incident.id}`,
      userId,
    });
    const delivery = (await alerting().deliveriesFor(incident.id)).find(
      (d) => d.contactType === "push",
    );
    expect(delivery?.dueAt).toBeNull();
    expect(await alerting().deliver(delivery?.id ?? "")).toBe("sent");

    const sent = http.requests.filter((r) => r.url === phone.endpoint).at(-1);
    expect(sent?.headers?.authorization).toMatch(/^vapid t=[\w.-]+, k=/);
    expect(sent?.headers?.["content-encoding"]).toBe("aes128gcm");
    /* Nothing readable on the wire. */
    expect(sent?.bodyBytes?.toString("latin1")).not.toContain("Checkout");
    const notification = phone.read(sent?.bodyBytes as Buffer);
    expect(notification).toMatchObject({
      url: `${WEB_ORIGIN}/w/${ws}/incidents/${incident.number}`,
      tag: `incident-${incident.id}`,
      incidentNumber: incident.number,
      kind: "triggered",
    });
    expect(String(notification.title)).toContain("Checkout down");

    /* What the service worker does when "Acknowledge" is tapped: no cookie, just the link. */
    const token = new URL(String(notification.acknowledgeUrl)).pathname.split("/").at(-1) ?? "";
    const tapped = await request(ctx.app).post(`/api/actions/${token}`);
    expect(tapped.status, tapped.text).toBe(200);
    expect(tapped.body).toMatchObject({ action: "acknowledge", result: "done" });
    const detail = await api("get", `/incidents/${incident.number}`);
    expect(detail.body.status).toBe("acknowledged");
    expect(detail.body.acknowledgedBy).toBe(userId);
    /* The link works once. */
    expect((await request(ctx.app).post(`/api/actions/${token}`)).status).toBe(409);
  });

  it("forgets a device whose browser dropped the subscription", async () => {
    const added = await api("post", "/me/contact-methods").send({
      type: "push",
      address: oldLaptop.endpoint,
      label: "Old laptop",
      push: oldLaptop.keys,
    });
    expect(added.status, added.text).toBe(201);
    const created = await api("post", "/incidents").send({
      title: "Search slow",
      severity: "high",
    });
    const incidentId = created.body.id as string;
    await alerting().notifyUser({ incidentId, eventKey: `page.${incidentId}`, userId });
    const gone = (await alerting().deliveriesFor(incidentId)).filter(
      (d) => d.contactType === "push",
    );
    expect(gone).toHaveLength(2);
    const outcomes: string[] = [];
    for (const d of gone) outcomes.push(await alerting().deliver(d.id));
    expect(outcomes.sort()).toEqual(["failed", "sent"]);
    expect((await methods()).map((m) => m.label)).not.toContain("Old laptop");
    expect((await methods()).map((m) => m.label)).toContain("Chrome on Android");
  });

  it("sends nothing to a device removed after the alert was planned", async () => {
    const created = await api("post", "/incidents").send({ title: "Removed", severity: "high" });
    const incidentId = created.body.id as string;
    await alerting().notifyUser({ incidentId, eventKey: `page.${incidentId}`, userId });
    const delivery = (await alerting().deliveriesFor(incidentId)).find(
      (d) => d.contactType === "push",
    );
    const mine = (await methods()).find((m) => m.type === "push");
    expect((await api("delete", `/me/contact-methods/${mine?.id}`)).status).toBe(204);
    const before = http.requests.length;
    expect(await alerting().deliver(delivery?.id ?? "")).toBe("skipped");
    expect(http.requests.length).toBe(before);
  });
});
