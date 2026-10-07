/*
 * P4-T08: a push message can be read only with the browser's keys (RFC 8291), and the VAPID header
 * is a JWT the push service can check against our public key (RFC 8292).
 */
import {
  createDecipheriv,
  createECDH,
  createHmac,
  createPublicKey,
  randomBytes,
  verify,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../core/clock.js";
import type { OutboundRequest } from "../http/outbound.js";
import { createWebPush, encryptPush, generateVapidKeys } from "../webpush.js";

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  return createHmac("sha256", prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest()
    .subarray(0, length);
}

/* What a browser does with a push message. */
function browser() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    subscription: {
      endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
      p256dh: ecdh.getPublicKey().toString("base64url"),
      auth: auth.toString("base64url"),
    },
    decrypt(message: Buffer): string {
      const salt = message.subarray(0, 16);
      const idLength = message[20] as number;
      const serverPublic = message.subarray(21, 21 + idLength);
      const body = message.subarray(21 + idLength);
      const shared = ecdh.computeSecret(serverPublic);
      const ikm = hkdf(
        auth,
        shared,
        Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), serverPublic]),
        32,
      );
      const key = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
      const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
      const decipher = createDecipheriv("aes-128-gcm", key, nonce);
      decipher.setAuthTag(body.subarray(body.length - 16));
      const plain = Buffer.concat([
        decipher.update(body.subarray(0, body.length - 16)),
        decipher.final(),
      ]);
      /* The last record ends with the 0x02 delimiter. */
      expect(plain.at(-1)).toBe(2);
      return plain.subarray(0, plain.length - 1).toString("utf8");
    },
  };
}

describe("encryptPush", () => {
  it("produces an aes128gcm message the subscribed browser can read", () => {
    const client = browser();
    const message = encryptPush(client.subscription, Buffer.from('{"title":"DOWN: Checkout"}'));
    expect(message.readUInt32BE(16)).toBe(4_096);
    expect(message[20]).toBe(65);
    expect(client.decrypt(message)).toBe('{"title":"DOWN: Checkout"}');
  });

  it("can't be read with another browser's keys, and differs every time", () => {
    const client = browser();
    const other = browser();
    const first = encryptPush(client.subscription, Buffer.from("secret"));
    const second = encryptPush(client.subscription, Buffer.from("secret"));
    expect(first.equals(second)).toBe(false);
    expect(() => other.decrypt(first)).toThrow();
  });
});

describe("createWebPush", () => {
  const keys = generateVapidKeys();
  const clock = createFakeClock("2026-10-06T12:00:00Z");

  function sender(status: number) {
    const requests: OutboundRequest[] = [];
    const push = createWebPush({
      ...keys,
      subject: "mailto:ops@example.com",
      clock,
      http: {
        async request(req) {
          requests.push(req);
          return { status, headers: {}, body: "" };
        },
      },
    });
    return { push, requests };
  }

  it("makes keys in the form browsers use", () => {
    expect(Buffer.from(keys.publicKey, "base64url")).toHaveLength(65);
    expect(Buffer.from(keys.privateKey, "base64url")).toHaveLength(32);
  });

  it("posts the encrypted message with a VAPID header the push service can verify", async () => {
    const client = browser();
    const { push, requests } = sender(201);
    expect(await push.send(client.subscription, { title: "DOWN", incidentId: "i-1" })).toEqual({
      ok: true,
    });
    const [req] = requests;
    expect(req?.url).toBe(client.subscription.endpoint);
    expect(req?.headers).toMatchObject({
      "content-encoding": "aes128gcm",
      ttl: "3600",
      urgency: "high",
    });
    expect(JSON.parse(client.decrypt(req?.bodyBytes as Buffer))).toEqual({
      title: "DOWN",
      incidentId: "i-1",
    });

    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(
      req?.headers?.authorization ?? "",
    );
    expect(match?.[4]).toBe(keys.publicKey);
    const claims = JSON.parse(Buffer.from(match?.[2] ?? "", "base64url").toString()) as {
      aud: string;
      exp: number;
      sub: string;
    };
    expect(claims).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: Math.floor(clock.now().getTime() / 1_000) + 12 * 3_600,
      sub: "mailto:ops@example.com",
    });
    const point = Buffer.from(keys.publicKey, "base64url");
    const publicKey = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: point.subarray(1, 33).toString("base64url"),
        y: point.subarray(33, 65).toString("base64url"),
      },
      format: "jwk",
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${match?.[1]}.${match?.[2]}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(match?.[3] ?? "", "base64url"),
      ),
    ).toBe(true);
  });

  it("tells a dropped subscription from a passing failure", async () => {
    const client = browser();
    expect(await sender(410).push.send(client.subscription, {})).toEqual({
      ok: false,
      gone: true,
      status: 410,
    });
    expect(await sender(404).push.send(client.subscription, {})).toMatchObject({ gone: true });
    expect(await sender(503).push.send(client.subscription, {})).toEqual({
      ok: false,
      gone: false,
      status: 503,
    });
  });
});
