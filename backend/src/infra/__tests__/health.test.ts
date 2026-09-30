import { describe, expect, it } from "vitest";
import { describeError, runReadinessChecks } from "../health.js";

describe("describeError", () => {
  it("uses the message of a normal error", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });

  it("expands an AggregateError with an empty message", () => {
    const v6 = Object.assign(new Error("connect ECONNREFUSED ::1:5432"), { code: "ECONNREFUSED" });
    const v4 = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
      code: "ECONNREFUSED",
    });
    expect(describeError(new AggregateError([v6, v4], ""))).toBe(
      "connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432",
    );
  });

  it("falls back to the error code, then the name", () => {
    expect(describeError(Object.assign(new Error(""), { code: "ETIMEDOUT" }))).toBe("ETIMEDOUT");
    expect(describeError(new TypeError(""))).toBe("TypeError");
    expect(describeError("plain")).toBe("plain");
  });
});

describe("runReadinessChecks", () => {
  it("never reports an empty error string", async () => {
    const result = await runReadinessChecks({
      db: async () => {
        throw new AggregateError([new Error("connect ECONNREFUSED 127.0.0.1:5432")], "");
      },
    });
    expect(result.ready).toBe(false);
    expect(result.checks.db?.error).toBe("connect ECONNREFUSED 127.0.0.1:5432");
  });

  it("times out slow checks", async () => {
    const result = await runReadinessChecks(
      { slow: () => new Promise((resolve) => setTimeout(resolve, 200)) },
      20,
    );
    expect(result.checks.slow).toMatchObject({ ok: false, error: "timed out after 20 ms" });
  });
});
