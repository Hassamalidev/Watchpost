/* What a probe keeps of a failed response (P2-T04): allowlisted headers and the start of a text body. */
import { describe, expect, it } from "vitest";
import { EVIDENCE_BODY_MAX_CHARS, type CheckResult } from "@app/shared";
import type { HttpResponse } from "../../net/http-client.js";
import {
  EVIDENCE_EVERY,
  EVIDENCE_FIRST_FAILURES,
  createEvidenceLimiter,
  evidenceOf,
} from "../evidence.js";

const response = (patch: Partial<HttpResponse>): HttpResponse => ({
  status: 502,
  headers: {},
  body: Buffer.alloc(0),
  truncated: false,
  ip: "203.0.113.9",
  timings: { dns: 5, connect: 10, ttfb: 100, download: 5, total: 120 },
  finalUrl: "https://example.com/",
  redirects: [],
  ...patch,
});

describe("evidence of a response", () => {
  it("keeps allowlisted headers only: no cookies, tokens or custom headers", () => {
    const evidence = evidenceOf(
      response({
        headers: {
          "content-type": "text/html; charset=utf-8",
          server: "nginx",
          "cf-ray": "8a1b2c3d4e5f-FRA",
          "set-cookie": "session=secret",
          authorization: "Bearer secret",
          "x-internal-token": "secret",
          "retry-after": "120",
        },
        body: Buffer.from("<h1>502 Bad Gateway</h1>"),
      }),
    );
    expect(evidence.headers).toEqual({
      "content-type": "text/html; charset=utf-8",
      server: "nginx",
      "cf-ray": "8a1b2c3d4e5f-FRA",
      "retry-after": "120",
    });
    expect(JSON.stringify(evidence)).not.toContain("secret");
    expect(evidence).toMatchObject({
      bodySnippet: "<h1>502 Bad Gateway</h1>",
      bodyBytes: 24,
      bodyTruncated: false,
    });
  });

  it("cuts a long body at the limit and says so", () => {
    const evidence = evidenceOf(
      response({
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ error: "x".repeat(10_000) })),
      }),
    );
    expect(evidence.bodySnippet).toHaveLength(EVIDENCE_BODY_MAX_CHARS);
    expect(evidence.bodyTruncated).toBe(true);
    expect(evidence.bodyBytes).toBeGreaterThan(10_000);
  });

  it("keeps no snippet of a binary body, declared or sniffed", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const declared = evidenceOf(response({ headers: { "content-type": "image/png" }, body: png }));
    expect(declared.bodySnippet).toBeUndefined();
    expect(declared.bodyBytes).toBe(png.length);
    expect(evidenceOf(response({ body: png })).bodySnippet).toBeUndefined();
    /* Without a content type, readable text is still kept. */
    expect(evidenceOf(response({ body: Buffer.from("upstream timed out") })).bodySnippet).toBe(
      "upstream timed out",
    );
  });

  it("strips control characters and keeps multi-byte text whole", () => {
    const evidence = evidenceOf(
      response({
        headers: { "content-type": "text/plain" },
        body: Buffer.from("Fehler\u0007: Dienst nicht verfügbar\n\tبعد قليل"),
      }),
    );
    expect(evidence.bodySnippet).toBe("Fehler: Dienst nicht verfügbar\n\tبعد قليل");
  });
});

describe("evidence limiter", () => {
  const result = (ok: boolean, patch: Partial<CheckResult> = {}): CheckResult => ({
    id: "018f0000-0000-7000-8000-000000000001",
    monitorId: "018f0000-0000-7000-8000-0000000000aa",
    region: "eu-central",
    checkedAt: "2026-10-05T10:00:00.000Z",
    ok,
    latencyMs: 10,
    ...(ok ? {} : { errorCode: "http_status_unexpected", evidence: { bodySnippet: "oops" } }),
    ...patch,
  });

  it("keeps evidence for the first failures of a streak, then every twentieth", () => {
    const limiter = createEvidenceLimiter();
    const kept: number[] = [];
    for (let n = 1; n <= 45; n += 1) {
      if (limiter.apply(result(false)).evidence !== undefined) kept.push(n);
    }
    expect(kept).toEqual([1, 2, 3, 20, 40]);
    expect(EVIDENCE_FIRST_FAILURES).toBe(3);
    expect(EVIDENCE_EVERY).toBe(20);
  });

  it("starts over after a success, and counts each monitor on its own", () => {
    const limiter = createEvidenceLimiter();
    for (let n = 0; n < 5; n += 1) limiter.apply(result(false));
    expect(limiter.apply(result(false)).evidence).toBeUndefined();
    limiter.apply(result(true));
    expect(limiter.apply(result(false)).evidence).toBeDefined();
    const other = { monitorId: "018f0000-0000-7000-8000-0000000000bb" };
    expect(limiter.apply(result(false, other)).evidence).toBeDefined();
  });

  it("always keeps evidence on verification and test results", () => {
    const limiter = createEvidenceLimiter();
    const task = { taskId: "018f0000-0000-7000-8000-0000000000cc" };
    for (let n = 0; n < 10; n += 1) limiter.apply(result(false));
    expect(limiter.apply(result(false, task)).evidence).toBeDefined();
  });
});
