import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createHealthRouter, describeError, runReadinessChecks } from "../health.js";

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

describe("/api/ready", () => {
  const app = (
    checks: Record<string, () => Promise<void>>,
    warnings: Record<string, () => Promise<void>>,
  ) => express().use("/api", createHealthRouter(checks, { warnings }));
  const ok = async () => undefined;
  const fail = (message: string) => async () => {
    throw new Error(message);
  };

  it("is ready with no warnings when everything passes", async () => {
    const res = await request(app({ postgres: ok, worker: ok }, { probes: ok })).get("/api/ready");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ready", warnings: {} });
  });

  it("a failing check makes it not ready and says which", async () => {
    const res = await request(
      app({ postgres: ok, worker: fail("the worker last ticked 75 s ago") }, {}),
    ).get("/api/ready");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("not_ready");
    expect(res.body.checks.worker).toMatchObject({
      ok: false,
      error: "the worker last ticked 75 s ago",
    });
  });

  it("a warning is reported but the platform stays ready", async () => {
    const res = await request(
      app({ postgres: ok }, { probes: fail("no healthy probe in ap-southeast"), other: ok }),
    ).get("/api/ready");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.warnings).toEqual({ probes: "no healthy probe in ap-southeast" });
  });
});
