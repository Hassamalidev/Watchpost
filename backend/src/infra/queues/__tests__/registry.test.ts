import { describe, expect, it } from "vitest";
import { DEFAULT_JOB_OPTIONS, QUEUES, QUEUE_NAMES, buildJobId, isQueueName } from "../index.js";

describe("queue registry", () => {
  it("lists every queue from PRODUCT.md §7.5 exactly once", () => {
    expect(new Set(QUEUE_NAMES).size).toBe(QUEUE_NAMES.length);
    expect(Object.keys(QUEUES).sort()).toEqual([...QUEUE_NAMES].sort());
  });

  it("gives every queue a recovery mode (sweep with a source, schedules, or ephemeral with a reason)", () => {
    for (const name of QUEUE_NAMES) {
      const { recovery } = QUEUES[name];
      if (recovery.mode === "sweep") expect(recovery.source.length).toBeGreaterThan(0);
      if (recovery.mode === "ephemeral") expect(recovery.reason.length).toBeGreaterThan(0);
    }
  });

  it("recognizes queue names", () => {
    expect(isQueueName("evaluate")).toBe(true);
    expect(isQueueName("alerting-events")).toBe(true);
    expect(isQueueName("nope")).toBe(false);
  });
});

describe("job defaults", () => {
  it("never removes failed jobs and backs off exponentially", () => {
    expect(DEFAULT_JOB_OPTIONS.removeOnFail).toBe(false);
    expect(DEFAULT_JOB_OPTIONS.backoff.type).toBe("exponential");
    expect(DEFAULT_JOB_OPTIONS.attempts).toBeGreaterThan(1);
  });
});

describe("buildJobId", () => {
  it("joins parts deterministically", () => {
    expect(buildJobId("eval", "m1", 42)).toBe("eval.m1.42");
    expect(buildJobId("eval", "m1", 42)).toBe(buildJobId("eval", "m1", 42));
  });

  it("never produces a ':' (BullMQ rejects most IDs containing it)", () => {
    const id = buildJobId(
      "timer",
      "snooze",
      "0190a3b2-7c1d-7e3f-8a9b-0c1d2e3f4a5b",
      1_790_000_000_000,
    );
    expect(id).not.toContain(":");
  });

  it("rejects empty parts and parts containing the separator", () => {
    expect(() => buildJobId()).toThrow();
    expect(() => buildJobId("eval", "")).toThrow();
    expect(() => buildJobId("eval", "a.b")).toThrow();
  });
});
