import { describe, expect, it } from "vitest";
import { buildChanges } from "../changes.js";
import { errorBudget, monthOf } from "../slo.js";

describe("error budgets", () => {
  it("uses the calendar month in UTC", () => {
    const { start, end } = monthOf(new Date("2026-02-14T10:00:00Z"));
    expect(start.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("allows 99.9 % of a 30-day month as about 43 minutes", () => {
    const budget = errorBudget({
      target: 99.9,
      usedSeconds: 0,
      now: new Date("2026-09-15T00:00:00Z"),
    });
    expect(budget.budgetSeconds).toBe(2592);
    expect(budget.remainingSeconds).toBe(2592);
    expect(budget.status).toBe("healthy");
  });

  it("flags a budget burning faster than the month passes", () => {
    /* Halfway through the month with 80 % used: burn rate 1.6. */
    const budget = errorBudget({
      target: 99.9,
      usedSeconds: 2074,
      now: new Date("2026-09-16T00:00:00Z"),
    });
    expect(budget.status).toBe("at_risk");
    expect(budget.burnRate).toBeGreaterThan(1.5);
  });

  it("marks a used-up budget as exhausted", () => {
    const budget = errorBudget({
      target: 99.9,
      usedSeconds: 3000,
      now: new Date("2026-09-20T00:00:00Z"),
    });
    expect(budget.status).toBe("exhausted");
    expect(budget.remainingSeconds).toBeLessThan(0);
  });
});

describe("what changed", () => {
  const before = new Date("2026-09-10T12:00:00Z");
  const at = (iso: string) => new Date(iso);
  const quietLatency = {
    recent: { averageMs: 120, count: 10 },
    baseline: { averageMs: 110, count: 50 },
  };

  it("reports an address change once across regions, but not different addresses per region", () => {
    const events = buildChanges({
      before,
      createdAt: at("2026-09-01T00:00:00Z"),
      ips: [
        {
          region: "eu",
          ip: "1.1.1.1",
          firstSeen: at("2026-09-10T08:00:00Z"),
          lastSeen: at("2026-09-10T10:59:00Z"),
        },
        {
          region: "us",
          ip: "2.2.2.2",
          firstSeen: at("2026-09-10T08:00:00Z"),
          lastSeen: at("2026-09-10T11:04:00Z"),
        },
        {
          region: "eu",
          ip: "3.3.3.3",
          firstSeen: at("2026-09-10T11:00:00Z"),
          lastSeen: at("2026-09-10T11:59:00Z"),
        },
        {
          region: "us",
          ip: "3.3.3.3",
          firstSeen: at("2026-09-10T11:05:00Z"),
          lastSeen: at("2026-09-10T11:59:00Z"),
        },
      ],
      certificates: [],
      configChanges: [],
      latency: quietLatency,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "address",
      regions: ["eu", "us"],
      at: "2026-09-10T11:00:00.000Z",
    });
  });

  it("reports certificate, settings and latency changes, newest first", () => {
    const events = buildChanges({
      before,
      createdAt: at("2026-09-01T00:00:00Z"),
      ips: [],
      certificates: [
        {
          region: "eu",
          fingerprint: "a",
          issuer: "Old CA",
          validTo: null,
          firstSeen: at("2026-09-10T06:00:00Z"),
          lastSeen: at("2026-09-10T08:55:00Z"),
        },
        {
          region: "eu",
          fingerprint: "b",
          issuer: "New CA",
          validTo: "2026-12-01T00:00:00Z",
          firstSeen: at("2026-09-10T09:00:00Z"),
          lastSeen: at("2026-09-10T11:59:00Z"),
        },
      ],
      configChanges: [at("2026-09-10T10:00:00Z")],
      latency: { recent: { averageMs: 900, count: 10 }, baseline: { averageMs: 150, count: 50 } },
    });
    expect(events.map((e) => e.kind)).toEqual(["latency", "config", "certificate"]);
    expect(events[2]!.detail).toContain("New CA");
  });

  it("does not call a rotating address pool a change", () => {
    const pool = ["10.0.0.1", "10.0.0.2", "10.0.0.3"].map((ip, i) => ({
      region: "eu",
      ip,
      firstSeen: at(`2026-09-10T0${i}:00:00Z`),
      lastSeen: at("2026-09-10T11:59:00Z"),
    }));
    const events = buildChanges({
      before,
      createdAt: at("2026-09-01T00:00:00Z"),
      ips: pool,
      certificates: [],
      configChanges: [],
      latency: quietLatency,
    });
    expect(events).toEqual([]);
  });

  it("does not call a small slowdown a change", () => {
    const events = buildChanges({
      before,
      createdAt: at("2026-09-01T00:00:00Z"),
      ips: [],
      certificates: [],
      configChanges: [],
      latency: { recent: { averageMs: 60, count: 10 }, baseline: { averageMs: 25, count: 50 } },
    });
    expect(events).toEqual([]);
  });
});
