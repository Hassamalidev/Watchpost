/* SMS text, call scripts, per-country credit costs and the provider's request signature. */
import { describe, expect, it } from "vitest";
import { MESSAGING_RATES, rateForPhone } from "../../../config/messaging-rates.js";
import { CREDIT_PROVIDER_COST_MICROS } from "../../../config/plans.js";
import {
  createTwilioProvider,
  gatherTwiml,
  messageTwiml,
  twilioSignature,
} from "../../../infra/messaging/index.js";
import { smsText, voiceText } from "../adapters/phone.js";
import type { AlertEvent } from "../types/adapter.js";

const event = (patch: Partial<AlertEvent> = {}, incident: Partial<AlertEvent["incident"]> = {}) =>
  ({
    kind: "triggered",
    workspace: { id: "w", name: "Acme" },
    incident: {
      id: "i",
      number: 482,
      title: "API Prod is down",
      severity: "high",
      status: "triggered",
      causeCode: null,
      failingRegions: ["a", "b", "c"],
      monitorName: "API Prod",
      startedAt: "2026-10-01T10:00:00.000Z",
      resolvedAt: null,
      durationSeconds: 0,
      url: "https://app.example/i",
      ...incident,
    },
    actor: null,
    at: "2026-10-01T10:00:00.000Z",
    explanation: { headline: "HTTP 502", detail: "", nextSteps: [] },
    ...patch,
  }) as AlertEvent;

describe("SMS text", () => {
  it("names the monitor, the cause and the reply codes", () => {
    expect(smsText(event())).toBe(
      "Watchpost: DOWN API Prod (HTTP 502, 3 regions) #482. Reply 1=ack 2=resolve",
    );
  });

  it("follow-ups say who acted and carry no reply codes", () => {
    expect(smsText(event({ kind: "acknowledged", actor: "Sara" }))).toBe(
      "Watchpost: ACK API Prod #482 by Sara.",
    );
    expect(smsText(event({ kind: "resolved" }))).toBe("Watchpost: OK API Prod #482.");
  });

  it("stays within one GSM segment whatever the monitor is called", () => {
    const long = smsText(event({}, { monitorName: "Сервис оплаты — production “EU” ".repeat(12) }));
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long).toMatch(/#482\. Reply 1=ack 2=resolve$/);
    /* Only characters of the GSM 7-bit alphabet, so the provider doesn't switch to UCS-2. */
    expect(long).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe("voice script", () => {
  it("reads the alert and asks for one key", () => {
    expect(voiceText(event())).toBe(
      "Watchpost alert. API Prod is down. HTTP 502. Incident number 482. Press 1 to acknowledge.",
    );
  });

  it("escapes text and the callback address in TwiML", () => {
    const xml = gatherTwiml('R&D "API" <down>', "https://api.example/voice?incident=1&x=2");
    expect(xml).toContain("R&amp;D &quot;API&quot; &lt;down&gt;");
    expect(xml).toContain('action="https://api.example/voice?incident=1&amp;x=2"');
    expect(messageTwiml("a < b")).toContain("<Message>a &lt; b</Message>");
  });
});

describe("credit costs per country", () => {
  it("one credit never costs us more than a payment sets aside for it", () => {
    for (const rate of MESSAGING_RATES) {
      const phone = `+${rate.prefix}${rate.prefix === "1" ? "4155550123" : "7700900123"}`;
      const price = rateForPhone(phone);
      expect(price, rate.country).toBeDefined();
      if (price === undefined) continue;
      expect(price.smsMicros / price.smsCredits, rate.country).toBeLessThanOrEqual(
        CREDIT_PROVIDER_COST_MICROS,
      );
      expect(price.voiceMinuteMicros / price.voiceCredits, rate.country).toBeLessThanOrEqual(
        CREDIT_PROVIDER_COST_MICROS,
      );
      expect(price.voiceCredits).toBeGreaterThanOrEqual(2);
    }
  });

  it("tells the +1 countries apart and refuses the expensive ones", () => {
    expect(rateForPhone("+14155550123")?.country).toBe("US");
    expect(rateForPhone("+14165550123")?.country).toBe("CA");
    expect(rateForPhone("+18765550123")).toBeUndefined();
    expect(rateForPhone("+19005550123")).toBeUndefined();
    expect(rateForPhone("+1415555")).toBeUndefined();
    expect(rateForPhone("+353871234567")?.country).toBe("IE");
    expect(rateForPhone("+8613800138000")).toBeUndefined();
  });
});

describe("provider signature", () => {
  /* The example from Twilio's "Validating signatures" documentation. */
  const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const params = {
    CallSid: "CA1234567890ABCDE",
    Caller: "+12349013030",
    Digits: "1234",
    From: "+12349013030",
    To: "+18005551212",
  };

  it("matches the documented example", () => {
    expect(twilioSignature("12345", url, params)).toBe("0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
  });

  it("verifies only an exact match", () => {
    const provider = createTwilioProvider({
      accountSid: "AC0",
      authToken: "12345",
      smsFrom: "+15005550006",
      http: { request: () => Promise.reject(new Error("not used")) },
    });
    expect(provider.verifySignature(url, params, "0/KCTR6DLpKmkAf8muzZqo1nDgQ=")).toBe(true);
    expect(
      provider.verifySignature(url, { ...params, Digits: "1" }, "0/KCTR6DLpKmkAf8muzZqo1nDgQ="),
    ).toBe(false);
    expect(provider.verifySignature(`${url}&x=1`, params, "0/KCTR6DLpKmkAf8muzZqo1nDgQ=")).toBe(
      false,
    );
    expect(provider.verifySignature(url, params, "")).toBe(false);
    expect(provider.canCall).toBe(false);
  });
});
