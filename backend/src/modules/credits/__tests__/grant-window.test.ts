import { describe, expect, it } from "vitest";
import { addMonthsUtc, grantWindow } from "../grant-window.js";

const at = (iso: string) => new Date(iso);
const windowOf = (start: string, end: string, now: string) => {
  const w = grantWindow(at(start), at(end), at(now));
  return w === null ? null : [w.start.toISOString(), w.end.toISOString()];
};

describe("addMonthsUtc", () => {
  it("clamps to the month's last day", () => {
    expect(addMonthsUtc(at("2026-01-31T10:00:00Z"), 1).toISOString()).toBe(
      "2026-02-28T10:00:00.000Z",
    );
    expect(addMonthsUtc(at("2028-01-31T10:00:00Z"), 1).toISOString()).toBe(
      "2028-02-29T10:00:00.000Z",
    );
    expect(addMonthsUtc(at("2026-11-15T00:00:00Z"), 3).toISOString()).toBe(
      "2027-02-15T00:00:00.000Z",
    );
  });
});

describe("grantWindow", () => {
  it("is the whole period for a monthly subscription", () => {
    expect(
      windowOf("2026-10-12T07:00:00Z", "2026-11-12T07:00:00Z", "2026-10-30T00:00:00Z"),
    ).toEqual(["2026-10-12T07:00:00.000Z", "2026-11-12T07:00:00.000Z"]);
  });

  it("never opens a second window when a monthly period runs a little past the month", () => {
    /* Paddle's period end can sit seconds or days after our calendar-month arithmetic. */
    expect(
      windowOf("2026-01-31T07:00:00Z", "2026-03-03T07:00:00Z", "2026-03-02T00:00:00Z"),
    ).toEqual(["2026-01-31T07:00:00.000Z", "2026-03-03T07:00:00.000Z"]);
  });

  it("cuts an annual period into twelve monthly windows", () => {
    const start = "2026-10-12T07:00:00Z";
    const end = "2027-10-12T07:00:00Z";
    expect(windowOf(start, end, "2026-10-12T07:00:00Z")).toEqual([
      "2026-10-12T07:00:00.000Z",
      "2026-11-12T07:00:00.000Z",
    ]);
    expect(windowOf(start, end, "2026-11-12T07:00:00Z")).toEqual([
      "2026-11-12T07:00:00.000Z",
      "2026-12-12T07:00:00.000Z",
    ]);
    expect(windowOf(start, end, "2027-10-01T00:00:00Z")).toEqual([
      "2027-09-12T07:00:00.000Z",
      "2027-10-12T07:00:00.000Z",
    ]);
    const starts = new Set<string>();
    for (let day = 0; day < 365; day += 1) {
      const w = grantWindow(at(start), at(end), new Date(at(start).getTime() + day * 86_400_000));
      if (w !== null) starts.add(w.start.toISOString());
    }
    expect(starts.size).toBe(12);
  });

  it("is null before the period starts and from the moment it ends", () => {
    expect(windowOf("2026-10-12T00:00:00Z", "2026-11-12T00:00:00Z", "2026-10-11T23:59:59Z")).toBe(
      null,
    );
    expect(windowOf("2026-10-12T00:00:00Z", "2026-11-12T00:00:00Z", "2026-11-12T00:00:00Z")).toBe(
      null,
    );
  });
});
