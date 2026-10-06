/* P2-T04 AC: every down alert states the failing regions, the cause code and the key timing. */
import { describe, expect, it } from "vitest";
import { alertFacts, plainDetails, renderPlain } from "../adapters/render.js";
import { smsText } from "../adapters/phone.js";
import type { AlertEvent } from "../types/adapter.js";

const TIMING = "Answered in 412 ms; slowest step: waiting for the first byte (370 ms)";

const event = (kind: AlertEvent["kind"], timing: string | null = TIMING): AlertEvent => ({
  kind,
  workspace: { id: "w", name: "Acme" },
  incident: {
    id: "i",
    number: 482,
    title: "API Prod is down",
    severity: "high",
    status: "triggered",
    causeCode: "http_status_unexpected",
    failingRegions: ["eu-central", "us-east"],
    timing,
    monitorName: "API Prod",
    startedAt: "2026-10-05T10:00:00.000Z",
    resolvedAt: null,
    durationSeconds: 0,
    url: "https://app.example/w/w/incidents/482",
  },
  actor: null,
  at: "2026-10-05T10:00:05.000Z",
  explanation: null,
});

describe("down alerts", () => {
  for (const kind of ["triggered", "reminder"] as const) {
    it(`${kind}: plain text states regions, cause and timing`, () => {
      const { text } = renderPlain(event(kind));
      expect(text).toContain("Failing regions: eu-central, us-east");
      expect(text).toContain("Cause: http_status_unexpected");
      expect(text).toContain(`Timing: ${TIMING}`);
    });

    it(`${kind}: rich formats and push bodies carry the same three facts`, () => {
      const facts = new Map(alertFacts(event(kind)).map((f) => [f.label, f.value]));
      expect(facts.get("Failing regions")).toBe("eu-central, us-east");
      expect(facts.get("Cause")).toBe("http_status_unexpected");
      expect(facts.get("Timing")).toBe(TIMING);
      const details = plainDetails(event(kind), renderPlain(event(kind)));
      expect(details).toContain("Failing regions: eu-central, us-east");
      expect(details).toContain("Cause: http_status_unexpected");
      expect(details).toContain(`Timing: ${TIMING}`);
    });
  }

  it("leaves the line out when the check wasn't timed", () => {
    expect(renderPlain(event("triggered", null)).text).not.toContain("Timing");
    expect(alertFacts(event("triggered", null)).map((f) => f.label)).not.toContain("Timing");
  });

  it("an SMS stays one segment: it names the cause and the number, not the timing", () => {
    const text = smsText(event("triggered"));
    expect(text.length).toBeLessThanOrEqual(160);
    expect(text).not.toContain("Timing");
  });
});
