/*
 * Small signed, expiring tokens for links we hand out (for example "link this chat user to your
 * account"): a JSON payload and its expiry, signed with HMAC-SHA256 under a key derived from the auth
 * secret and a purpose, so a token made for one purpose can't be used for another.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface TokenSigner<T> {
  sign(payload: T, expiresAt: Date): string;
  /* The payload, or undefined when the token is forged, malformed or expired. */
  verify(token: string, now: Date): T | undefined;
}

export function createTokenSigner<T>(secret: string, purpose: string): TokenSigner<T> {
  const key = createHmac("sha256", secret).update(`signed-token:${purpose}`).digest();
  const mac = (body: string) => createHmac("sha256", key).update(body).digest("base64url");
  return {
    sign(payload, expiresAt) {
      const body = Buffer.from(JSON.stringify({ p: payload, exp: expiresAt.getTime() })).toString(
        "base64url",
      );
      return `${body}.${mac(body)}`;
    },
    verify(token, now) {
      const [body, signature, extra] = token.split(".");
      if (body === undefined || signature === undefined || extra !== undefined) return undefined;
      const expected = Buffer.from(mac(body));
      const given = Buffer.from(signature);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
      try {
        const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
          p: T;
          exp: number;
        };
        if (typeof parsed.exp !== "number" || parsed.exp <= now.getTime()) return undefined;
        return parsed.p;
      } catch {
        return undefined;
      }
    },
  };
}
