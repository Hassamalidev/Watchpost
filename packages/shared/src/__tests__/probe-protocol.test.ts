import { describe, expect, it } from "vitest";
import {
  CHECK_ERROR_CODES,
  PROBE_MAX_BATCH_RESULTS,
  checkErrorImpact,
  checkResultSchema,
  countsAsCustomerFailure,
  probeSigningString,
  resultsBatchSchema,
} from "../index.js";

const ID = "0190a3b2-7c1d-7e3f-8a9b-0c1d2e3f4a5b";
const result = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  monitorId: ID,
  region: "eu-central",
  checkedAt: "2026-09-30T12:00:00.000Z",
  ok: true,
  latencyMs: 120,
  timings: { dns: 5, connect: 20, tls: 30, ttfb: 60, download: 5, total: 120 },
  ...overrides,
});

describe("check results", () => {
  it("accepts a successful result with a timing waterfall", () => {
    expect(checkResultSchema.safeParse(result()).success).toBe(true);
  });

  it("requires an error code on failures and rejects unknown codes and regions", () => {
    expect(checkResultSchema.safeParse(result({ ok: false })).success).toBe(false);
    expect(
      checkResultSchema.safeParse(result({ ok: false, errorCode: "connect_refused" })).success,
    ).toBe(true);
    expect(checkResultSchema.safeParse(result({ ok: false, errorCode: "made_up" })).success).toBe(
      false,
    );
    expect(checkResultSchema.safeParse(result({ region: "moon" })).success).toBe(false);
  });

  it("caps batch sizes", () => {
    const one = { batchId: ID, results: [result()] };
    expect(resultsBatchSchema.safeParse(one).success).toBe(true);
    expect(resultsBatchSchema.safeParse({ batchId: ID, results: [] }).success).toBe(false);
    const tooMany = {
      batchId: ID,
      results: Array.from({ length: PROBE_MAX_BATCH_RESULTS + 1 }, () => result()),
    };
    expect(resultsBatchSchema.safeParse(tooMany).success).toBe(false);
  });
});

describe("error taxonomy (Appendix B)", () => {
  it("never counts probe faults or config errors as customer failures", () => {
    expect(countsAsCustomerFailure("probe_error")).toBe(false);
    expect(countsAsCustomerFailure("probe_overloaded")).toBe(false);
    expect(countsAsCustomerFailure("ssrf_blocked")).toBe(false);
    expect(countsAsCustomerFailure("latency_threshold")).toBe(false);
    expect(countsAsCustomerFailure("connect_refused")).toBe(true);
    expect(checkErrorImpact("heartbeat_too_long")).toBe("degraded");
  });

  it("uses snake_case codes and lists every probe_* code as ours", () => {
    for (const code of CHECK_ERROR_CODES) {
      expect(code).toMatch(/^[a-z]+(_[a-z0-9]+)*$/);
      if (code.startsWith("probe_")) expect(checkErrorImpact(code)).toBe("ours");
    }
  });
});

describe("probe signing string", () => {
  it("joins timestamp, upper-case method, path and body hash with newlines", () => {
    expect(
      probeSigningString({
        timestamp: 1790000000,
        method: "post",
        path: "/api/probe/v1/results",
        bodySha256Hex: "ab12",
      }),
    ).toBe("1790000000\nPOST\n/api/probe/v1/results\nab12");
  });
});
