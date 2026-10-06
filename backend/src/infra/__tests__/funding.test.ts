/* Provider balance readers without the network (a stub fetch stands in for Twilio). */
import { describe, expect, it, vi } from "vitest";
import {
  TWILIO_BALANCE_URL,
  anthropicBalanceReader,
  createTwilioBalanceReader,
} from "../funding/index.js";

const SID = `AC${"a".repeat(32)}`;

function twilio(response: { status?: number; body?: unknown }) {
  const fetchStub = vi.fn(
    async () =>
      new Response(JSON.stringify(response.body ?? {}), { status: response.status ?? 200 }),
  );
  const reader = createTwilioBalanceReader({
    accountSid: SID,
    authToken: "token-0123456789abcdef",
    fetch: fetchStub as unknown as typeof fetch,
  });
  return { reader, fetchStub };
}

describe("Twilio balance reader", () => {
  it("reads the USD balance in micro-USD with basic auth", async () => {
    const { reader, fetchStub } = twilio({ body: { balance: "42.1857", currency: "USD" } });
    expect(await reader.balanceMicros()).toBe(42_185_700);
    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(TWILIO_BALANCE_URL(SID));
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from(`${SID}:token-0123456789abcdef`).toString("base64")}`,
    );
  });

  it("reports nothing for another currency or a malformed answer", async () => {
    expect(await twilio({ body: { balance: "10", currency: "EUR" } }).reader.balanceMicros()).toBe(
      null,
    );
    expect(await twilio({ body: { currency: "USD" } }).reader.balanceMicros()).toBe(null);
  });

  it("fails loudly when Twilio refuses the request", async () => {
    await expect(twilio({ status: 401 }).reader.balanceMicros()).rejects.toThrow(/HTTP 401/);
  });
});

describe("Anthropic balance reader", () => {
  it("reports nothing: Anthropic has no balance API", async () => {
    expect(await anthropicBalanceReader.balanceMicros()).toBeNull();
  });
});
