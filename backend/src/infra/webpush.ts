/*
 * Web Push without a library: VAPID (RFC 8292) to say who we are and message encryption for Web
 * Push (RFC 8291, `aes128gcm` from RFC 8188) so only the browser can read the message. A browser's
 * subscription is an endpoint URL at its push service plus two keys (`p256dh`, `auth`).
 *
 * The VAPID key pair is a P-256 key in the form browsers use: the public key as the 65-byte
 * uncompressed point, the private key as its 32-byte scalar, both base64url
 * (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`; make a pair with `generateVapidKeys`).
 */
import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import type { Clock } from "../core/clock.js";
import type { OutboundHttp } from "./http/outbound.js";

export interface PushSubscription {
  endpoint: string;
  /* The browser's public key and auth secret, base64url. */
  p256dh: string;
  auth: string;
}

export type PushOutcome =
  | { ok: true }
  /* gone: the browser dropped the subscription (404/410); it will never work again. */
  | { ok: false; gone: boolean; status: number };

export interface WebPush {
  /* The public key a browser subscribes with. */
  publicKey: string;
  send(
    subscription: PushSubscription,
    payload: unknown,
    options?: { ttlSeconds?: number },
  ): Promise<PushOutcome>;
}

const b64u = (data: Buffer) => data.toString("base64url");
const fromB64u = (text: string) => Buffer.from(text, "base64url");

/*
 * A P-256 private key as the 32 bytes browsers and JWK expect. Node hands it back without leading
 * zero bytes, so about one key in 256 would otherwise come out a byte short.
 */
export function scalar32(key: Buffer): Buffer {
  if (key.length >= 32) return key;
  return Buffer.concat([Buffer.alloc(32 - key.length), key]);
}

export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(scalar32(ecdh.getPrivateKey())) };
}

/* HKDF (RFC 5869) with SHA-256, for outputs of at most 32 bytes. */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  return createHmac("sha256", prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest()
    .subarray(0, length);
}

/* RFC 8291: one record, padded with the 0x02 delimiter, readable only with the browser's keys. */
export function encryptPush(
  subscription: Pick<PushSubscription, "p256dh" | "auth">,
  plaintext: Buffer,
  /* Tests pass fixed values; production uses fresh random ones for every message. */
  fixed?: { salt: Buffer; privateKey: Buffer },
): Buffer {
  const clientPublic = fromB64u(subscription.p256dh);
  const authSecret = fromB64u(subscription.auth);
  const server = createECDH("prime256v1");
  if (fixed === undefined) server.generateKeys();
  else server.setPrivateKey(fixed.privateKey);
  const serverPublic = server.getPublicKey();
  const shared = server.computeSecret(clientPublic);
  const salt = fixed?.salt ?? randomBytes(16);

  const ikm = hkdf(
    authSecret,
    shared,
    Buffer.concat([Buffer.from("WebPush: info\0"), clientPublic, serverPublic]),
    32,
  );
  const key = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const cipher = createCipheriv("aes-128-gcm", key, nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  /* Header: salt, record size, key ID length, key ID (our public key). */
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4_096);
  return Buffer.concat([salt, recordSize, Buffer.from([serverPublic.length]), serverPublic, body]);
}

function vapidKey(publicKey: string, privateKey: string): KeyObject {
  const point = fromB64u(publicKey);
  if (point.length !== 65 || point[0] !== 4) throw new Error("VAPID_PUBLIC_KEY isn't a P-256 key");
  return createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: privateKey,
      x: b64u(point.subarray(1, 33)),
      y: b64u(point.subarray(33, 65)),
    },
    format: "jwk",
  });
}

/* The `Authorization` header for one push service origin, valid for twelve hours. */
export function vapidAuthorization(input: {
  endpoint: string;
  publicKey: string;
  key: KeyObject;
  subject: string;
  now: Date;
}): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(
    Buffer.from(
      JSON.stringify({
        aud: new URL(input.endpoint).origin,
        exp: Math.floor(input.now.getTime() / 1_000) + 12 * 3_600,
        sub: input.subject,
      }),
    ),
  );
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
    key: input.key,
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${input.publicKey}`;
}

export function createWebPush(options: {
  publicKey: string;
  privateKey: string;
  /* A mailto: or https: contact the push service can reach us at. */
  subject: string;
  http: OutboundHttp;
  clock: Clock;
}): WebPush {
  const key = vapidKey(options.publicKey, options.privateKey);
  return {
    publicKey: options.publicKey,
    async send(subscription, payload, sendOptions = {}) {
      const body = encryptPush(subscription, Buffer.from(JSON.stringify(payload), "utf8"));
      const res = await options.http.request({
        method: "POST",
        url: subscription.endpoint,
        headers: {
          authorization: vapidAuthorization({
            endpoint: subscription.endpoint,
            publicKey: options.publicKey,
            key,
            subject: options.subject,
            now: options.clock.now(),
          }),
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          /* An alert that can't be delivered within the hour is no longer worth a buzz. */
          ttl: String(sendOptions.ttlSeconds ?? 3_600),
          urgency: "high",
        },
        bodyBytes: body,
      });
      if (res.status >= 200 && res.status < 300) return { ok: true };
      return { ok: false, gone: res.status === 404 || res.status === 410, status: res.status };
    },
  };
}
