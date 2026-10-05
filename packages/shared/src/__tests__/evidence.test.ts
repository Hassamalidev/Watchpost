/* Evidence of a failed check: the header allowlist, the result schema, keys and the timing sentence. */
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_BODY_MAX_CHARS,
  EVIDENCE_HEADER_VALUE_MAX,
  checkResultSchema,
  describeEvidenceTiming,
  describeTiming,
  evidenceKey,
  evidenceKeyPrefix,
  formatMs,
  pickEvidenceHeaders,
  slowestPhase,
} from "../index.js";

describe("evidence headers", () => {
  it("keeps only allowlisted names, whatever their case, and cuts long values", () => {
    expect(
      pickEvidenceHeaders({
        "Content-Type": "application/json",
        SERVER: "nginx",
        "Set-Cookie": "sid=secret",
        Authorization: "Bearer secret",
        "x-api-key": "secret",
        location: `https://example.com/${"a".repeat(1_000)}`,
        via: undefined,
      }),
    ).toEqual({
      "content-type": "application/json",
      server: "nginx",
      location: `https://example.com/${"a".repeat(1_000)}`.slice(0, EVIDENCE_HEADER_VALUE_MAX),
    });
  });
});

describe("result schema", () => {
  const base = {
    id: "018f0000-0000-7000-8000-000000000001",
    monitorId: "018f0000-0000-7000-8000-0000000000aa",
    region: "eu-central",
    checkedAt: "2026-10-05T10:00:00.000Z",
    ok: false,
    errorCode: "http_status_unexpected",
    latencyMs: 400,
  };

  it("accepts evidence within its limits and refuses an oversized body", () => {
    const ok = checkResultSchema.safeParse({
      ...base,
      evidence: { headers: { server: "nginx" }, bodySnippet: "oops", bodyBytes: 4 },
    });
    expect(ok.success).toBe(true);
    const tooLong = checkResultSchema.safeParse({
      ...base,
      evidence: { bodySnippet: "x".repeat(EVIDENCE_BODY_MAX_CHARS + 1) },
    });
    expect(tooLong.success).toBe(false);
  });
});

describe("evidence keys", () => {
  it("name the workspace and the day, so reads can check the workspace", () => {
    const key = evidenceKey("ws-1", "2026-10-05T10:00:00.000Z", "result-1");
    expect(key).toBe("evidence/ws-1/2026-10-05/result-1.json");
    expect(key.startsWith(evidenceKeyPrefix("ws-1"))).toBe(true);
    expect(key.startsWith(evidenceKeyPrefix("ws-10"))).toBe(false);
  });
});

describe("timing sentence", () => {
  it("formats durations for people", () => {
    expect([formatMs(0.4), formatMs(412), formatMs(9_840), formatMs(61_200)]).toEqual([
      "0 ms",
      "412 ms",
      "9.8 s",
      "61 s",
    ]);
  });

  it("names the slowest step when at least two were timed", () => {
    expect(slowestPhase({ dns: 4, connect: 12, ttfb: 370, total: 412 })).toEqual({
      phase: "ttfb",
      ms: 370,
    });
    expect(slowestPhase({ connect: 12, total: 12 })).toBeNull();
    expect(slowestPhase(null)).toBeNull();
  });

  it("says whether the server answered", () => {
    expect(
      describeTiming({ timings: { dns: 4, connect: 12, ttfb: 370, total: 412 }, answered: true }),
    ).toBe("Answered in 412 ms; slowest step: waiting for the first byte (370 ms)");
    expect(describeTiming({ latencyMs: 10_000, answered: false })).toBe("Failed after 10 s");
    expect(describeTiming({ latencyMs: 0, answered: false })).toBeNull();
  });

  it("reads the same facts from what an incident keeps", () => {
    expect(
      describeEvidenceTiming({
        httpStatus: 503,
        latencyMs: 2_300,
        timings: { dns: 2_000, connect: 100, total: 2_300 },
      }),
    ).toBe("Answered in 2.3 s; slowest step: DNS lookup (2.0 s)");
    expect(describeEvidenceTiming({ httpStatus: null, latencyMs: 30 })).toBe("Failed after 30 ms");
    expect(describeEvidenceTiming({ message: "old incident" })).toBeNull();
    expect(describeEvidenceTiming(null)).toBeNull();
  });
});
