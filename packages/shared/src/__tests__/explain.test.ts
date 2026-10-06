/* The failure explainer gives a specific cause and next steps for every failure class. */
import { describe, expect, it } from "vitest";
import { CHECK_ERROR_CODES } from "../constants/check-errors.js";
import { explainFailure } from "../explain/failure.js";

describe("explainFailure", () => {
  it("explains every error code without falling back to the generic text", () => {
    for (const errorCode of CHECK_ERROR_CODES) {
      if (
        errorCode === "probe_error" ||
        errorCode === "probe_overloaded" ||
        errorCode === "latency_threshold" ||
        errorCode === "heartbeat_too_long"
      )
        continue;
      const e = explainFailure({ errorCode, target: "https://api.example.com/health" });
      expect(e.category, errorCode).not.toBe("unknown");
      expect(e.headline.length, errorCode).toBeGreaterThan(5);
      expect(e.nextSteps.length, errorCode).toBeGreaterThan(0);
    }
  });

  it("reads HTTP statuses: gateway, overload, auth, missing, rate limit", () => {
    const http = (httpStatus: number) =>
      explainFailure({
        errorCode: "http_status_unexpected",
        httpStatus,
        target: "https://shop.example.com/",
      });
    expect(http(502).headline).toMatch(/Gateway error/);
    expect(http(502).detail).toContain("shop.example.com");
    expect(http(503).headline).toMatch(/overloaded or in maintenance/);
    expect(http(500).headline).toBe("Server error (HTTP 500)");
    expect(http(403).nextSteps[0]).toMatch(/WAF/);
    expect(http(404).headline).toMatch(/not found/);
    expect(http(429).headline).toMatch(/Rate limited/);
  });

  it("names the host and tells regional problems from global ones", () => {
    const everywhere = explainFailure({
      errorCode: "connect_refused",
      target: "db.example.com",
      failingRegions: ["eu-central", "us-east"],
      totalRegions: 2,
    });
    expect(everywhere.headline).toBe("Nothing is listening on db.example.com");
    expect(everywhere.scope).toBe("everywhere");

    const regional = explainFailure({
      errorCode: "connect_timeout",
      target: "https://api.example.com",
      failingRegions: ["ap-southeast"],
      totalRegions: 3,
    });
    expect(regional.scope).toBe("some-regions");
    expect(regional.nextSteps[0]).toMatch(/Only ap-southeast sees it/);
  });
});
