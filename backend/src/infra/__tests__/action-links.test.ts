/* Action links: signed, bound to recipient, incident and action, expiring after 24 hours. */
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../core/clock.js";
import { ActionLinkError, createActionLinks } from "../action-links.js";

const clock = createFakeClock("2026-10-01T12:00:00Z");
const links = createActionLinks({
  secret: "s".repeat(40),
  webOrigin: "https://app.example.com",
  clock,
});
const input = {
  workspaceId: "0190a000-0000-7000-8000-000000000001",
  incidentId: "0190a000-0000-7000-8000-000000000002",
  action: "acknowledge" as const,
  recipient: "Sara@Example.com",
};
const tokenOf = (url: string) => url.split("/a/")[1] ?? "";

const reasonOf = (fn: () => unknown) => {
  try {
    fn();
    return "ok";
  } catch (err) {
    return err instanceof ActionLinkError ? err.reason : "other";
  }
};

describe("action links", () => {
  it("round-trips the claims with a fresh nonce per link", () => {
    const first = links.url(input);
    expect(first.startsWith("https://app.example.com/a/")).toBe(true);
    const claims = links.verify(tokenOf(first));
    expect(claims).toMatchObject({
      workspaceId: input.workspaceId,
      incidentId: input.incidentId,
      action: "acknowledge",
      recipient: "sara@example.com",
      expiresAt: new Date("2026-10-02T12:00:00Z"),
    });
    expect(links.verify(tokenOf(links.url(input))).nonce).not.toBe(claims.nonce);
  });

  it("rejects tampered, foreign and malformed tokens", () => {
    const token = tokenOf(links.url(input));
    const [payload, signature] = token.split(".") as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), a: "resolve" }),
    ).toString("base64url");
    expect(reasonOf(() => links.verify(`${forged}.${signature}`))).toBe("invalid");
    const other = createActionLinks({ secret: "t".repeat(40), webOrigin: "x", clock });
    expect(reasonOf(() => other.verify(token))).toBe("invalid");
    expect(reasonOf(() => links.verify("garbage"))).toBe("invalid");
    expect(reasonOf(() => links.verify(`${token}.extra`))).toBe("invalid");
  });

  it("expires after 24 hours", () => {
    const token = tokenOf(links.url(input));
    clock.advance(24 * 3_600_000 - 1);
    expect(reasonOf(() => links.verify(token))).toBe("ok");
    clock.advance(1);
    expect(reasonOf(() => links.verify(token))).toBe("expired");
  });
});
