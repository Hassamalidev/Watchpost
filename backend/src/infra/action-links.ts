/*
 * Signed action links in alert emails (PRODUCT.md §10): "Acknowledge" and "Resolve" without signing
 * in. A token carries the workspace, incident, action, recipient, expiry (24 h) and a random nonce,
 * signed with HMAC-SHA256 under a key derived from the auth secret. Signing is stateless; the
 * `actions` module records each nonce when used, which makes links single-use.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Clock } from "../core/clock.js";

export const ACTION_LINK_TTL_MS = 24 * 3_600_000;
export const LINK_ACTIONS = ["acknowledge", "resolve"] as const;
export type LinkAction = (typeof LINK_ACTIONS)[number];

const claimsSchema = z.object({
  v: z.literal(1),
  w: z.uuid(),
  i: z.uuid(),
  a: z.enum(LINK_ACTIONS),
  r: z.string().min(3).max(320),
  exp: z.number().int(),
  n: z.string().min(16).max(64),
});

export interface ActionClaims {
  workspaceId: string;
  incidentId: string;
  action: LinkAction;
  recipient: string;
  expiresAt: Date;
  nonce: string;
}

export class ActionLinkError extends Error {
  constructor(
    readonly reason: "invalid" | "expired",
    message: string,
  ) {
    super(message);
    this.name = "ActionLinkError";
  }
}

export interface ActionLinks {
  /* The full URL of the web page that confirms the action. */
  url(input: {
    workspaceId: string;
    incidentId: string;
    action: LinkAction;
    recipient: string;
  }): string;
  verify(token: string): ActionClaims;
}

export function createActionLinks(options: {
  secret: string;
  webOrigin: string;
  clock: Clock;
  ttlMs?: number;
}): ActionLinks {
  const key = createHmac("sha256", options.secret).update("watchpost-action-links-v1").digest();
  const ttl = options.ttlMs ?? ACTION_LINK_TTL_MS;
  const sign = (payload: string) => createHmac("sha256", key).update(payload).digest("base64url");

  return {
    url(input) {
      const claims = {
        v: 1 as const,
        w: input.workspaceId,
        i: input.incidentId,
        a: input.action,
        r: input.recipient.toLowerCase(),
        exp: options.clock.now().getTime() + ttl,
        n: randomBytes(16).toString("base64url"),
      };
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      return `${options.webOrigin}/a/${payload}.${sign(payload)}`;
    },

    verify(token) {
      const [payload, signature, extra] = token.split(".");
      if (!payload || !signature || extra !== undefined) {
        throw new ActionLinkError("invalid", "This link isn't valid.");
      }
      const expected = Buffer.from(sign(payload));
      const given = Buffer.from(signature);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
        throw new ActionLinkError("invalid", "This link isn't valid.");
      }
      let parsed: z.infer<typeof claimsSchema>;
      try {
        parsed = claimsSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
      } catch {
        throw new ActionLinkError("invalid", "This link isn't valid.");
      }
      if (parsed.exp <= options.clock.now().getTime()) {
        throw new ActionLinkError(
          "expired",
          "This link has expired. Open the incident in Watchpost instead.",
        );
      }
      return {
        workspaceId: parsed.w,
        incidentId: parsed.i,
        action: parsed.a,
        recipient: parsed.r,
        expiresAt: new Date(parsed.exp),
        nonce: parsed.n,
      };
    },
  };
}
