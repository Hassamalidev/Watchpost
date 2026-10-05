/* Maintenance recurrence (P2-T05 AC: a recurring window across a DST change behaves correctly). */
import { describe, expect, it } from "vitest";
import {
  RecurrenceError,
  formatRule,
  isOver,
  nextOccurrence,
  occurrenceAt,
  occurrencesBetween,
  parseRule,
  type WindowSpec,
} from "../recurrence.js";

const utc = (iso: string) => new Date(iso);
const iso = (o: { start: Date; end: Date } | null) =>
  o === null ? null : [o.start.toISOString(), o.end.toISOString()];

describe("one-off windows", () => {
  const spec: WindowSpec = {
    startsAt: utc("2026-11-03T22:00:00Z"),
    endsAt: utc("2026-11-04T00:00:00Z"),
    rrule: null,
    timezone: "UTC",
  };

  it("are in effect from their start until just before their end", () => {
    expect(occurrenceAt(spec, utc("2026-11-03T21:59:59Z"))).toBeNull();
    expect(occurrenceAt(spec, utc("2026-11-03T22:00:00Z"))).not.toBeNull();
    expect(occurrenceAt(spec, utc("2026-11-03T23:59:59Z"))).not.toBeNull();
    expect(occurrenceAt(spec, utc("2026-11-04T00:00:00Z"))).toBeNull();
    expect(isOver(spec, utc("2026-11-03T23:00:00Z"))).toBe(false);
    expect(isOver(spec, utc("2026-11-04T00:00:00Z"))).toBe(true);
  });
});

describe("daylight saving", () => {
  /* Berlin: UTC+2 until Sunday 25 October 2026 03:00, then UTC+1. */
  const weekly: WindowSpec = {
    startsAt: utc("2026-10-17T20:00:00Z"),
    endsAt: utc("2026-10-17T22:00:00Z"),
    rrule: "FREQ=WEEKLY",
    timezone: "Europe/Berlin",
  };

  it("keeps the local start time when the clocks go back, so the UTC time moves", () => {
    const found = occurrencesBetween(
      weekly,
      utc("2026-10-17T00:00:00Z"),
      utc("2026-11-08T00:00:00Z"),
    );
    expect(found.map(iso)).toEqual([
      /* Saturdays 22:00 to midnight in Berlin: 20:00Z in summer time, 21:00Z after the change. */
      ["2026-10-17T20:00:00.000Z", "2026-10-17T22:00:00.000Z"],
      ["2026-10-24T20:00:00.000Z", "2026-10-24T22:00:00.000Z"],
      ["2026-10-31T21:00:00.000Z", "2026-10-31T23:00:00.000Z"],
      ["2026-11-07T21:00:00.000Z", "2026-11-07T23:00:00.000Z"],
    ]);
    /* 20:30Z is inside the window before the change and an hour early after it. */
    expect(occurrenceAt(weekly, utc("2026-10-24T20:30:00Z"))).not.toBeNull();
    expect(occurrenceAt(weekly, utc("2026-10-31T20:30:00Z"))).toBeNull();
    expect(occurrenceAt(weekly, utc("2026-10-31T21:30:00Z"))).not.toBeNull();
  });

  it("keeps the local start time when the clocks go forward", () => {
    /* New York: UTC-5 until Sunday 14 March 2027 02:00, then UTC-4. Daily at 23:00 for an hour. */
    const nightly: WindowSpec = {
      startsAt: utc("2027-03-13T04:00:00Z"),
      endsAt: utc("2027-03-13T05:00:00Z"),
      rrule: "FREQ=DAILY",
      timezone: "America/New_York",
    };
    const found = occurrencesBetween(
      nightly,
      utc("2027-03-13T00:00:00Z"),
      utc("2027-03-16T00:00:00Z"),
    );
    expect(found.map((o) => o.start.toISOString())).toEqual([
      "2027-03-13T04:00:00.000Z",
      "2027-03-14T04:00:00.000Z",
      "2027-03-15T03:00:00.000Z",
    ]);
    expect(found.every((o) => o.end.getTime() - o.start.getTime() === 3_600_000)).toBe(true);
  });

  it("a window that spans the change lasts as long as the first one did", () => {
    /* Sundays 01:00 for three hours, Berlin: on 25 October the clock repeats an hour inside it. */
    const spanning: WindowSpec = {
      startsAt: utc("2026-10-17T23:00:00Z"),
      endsAt: utc("2026-10-18T02:00:00Z"),
      rrule: "FREQ=WEEKLY",
      timezone: "Europe/Berlin",
    };
    const [, second] = occurrencesBetween(
      spanning,
      utc("2026-10-17T00:00:00Z"),
      utc("2026-10-26T00:00:00Z"),
    );
    expect(iso(second ?? null)).toEqual(["2026-10-24T23:00:00.000Z", "2026-10-25T02:00:00.000Z"]);
  });
});

describe("rules", () => {
  const base = { startsAt: utc("2026-11-02T10:00:00Z"), endsAt: utc("2026-11-02T11:00:00Z") };

  it("every second week on chosen weekdays, starting with the first occurrence", () => {
    /* 2 November 2026 is a Monday. */
    const spec: WindowSpec = {
      ...base,
      rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE,MO",
      timezone: "UTC",
    };
    const found = occurrencesBetween(
      spec,
      utc("2026-11-01T00:00:00Z"),
      utc("2026-11-30T00:00:00Z"),
    );
    expect(found.map((o) => o.start.toISOString().slice(0, 10))).toEqual([
      "2026-11-02",
      "2026-11-04",
      "2026-11-16",
      "2026-11-18",
    ]);
  });

  it("COUNT and UNTIL end the series", () => {
    const counted: WindowSpec = { ...base, rrule: "FREQ=DAILY;COUNT=3", timezone: "UTC" };
    expect(
      occurrencesBetween(counted, utc("2026-11-01T00:00:00Z"), utc("2026-12-01T00:00:00Z")),
    ).toHaveLength(3);
    expect(isOver(counted, utc("2026-11-04T10:30:00Z"))).toBe(false);
    expect(isOver(counted, utc("2026-11-04T11:00:00Z"))).toBe(true);

    const until: WindowSpec = { ...base, rrule: "FREQ=DAILY;UNTIL=20261104", timezone: "UTC" };
    expect(
      occurrencesBetween(until, utc("2026-11-01T00:00:00Z"), utc("2026-12-01T00:00:00Z")).map((o) =>
        o.start.toISOString().slice(0, 10),
      ),
    ).toEqual(["2026-11-02", "2026-11-03", "2026-11-04"]);
  });

  it("monthly on a day the month lacks falls on its last day", () => {
    const spec: WindowSpec = {
      startsAt: utc("2027-01-31T03:00:00Z"),
      endsAt: utc("2027-01-31T04:00:00Z"),
      rrule: "FREQ=MONTHLY",
      timezone: "UTC",
    };
    const found = occurrencesBetween(
      spec,
      utc("2027-01-01T00:00:00Z"),
      utc("2027-04-01T00:00:00Z"),
    );
    expect(found.map((o) => o.start.toISOString().slice(0, 10))).toEqual([
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
    ]);
  });

  it("finds an occurrence years after the first without walking every one", () => {
    const spec: WindowSpec = { ...base, rrule: "FREQ=DAILY", timezone: "UTC" };
    expect(iso(occurrenceAt(spec, utc("2031-06-15T10:20:00Z")))).toEqual([
      "2031-06-15T10:00:00.000Z",
      "2031-06-15T11:00:00.000Z",
    ]);
    expect(iso(nextOccurrence(spec, utc("2031-06-15T10:20:00Z")))?.[0]).toBe(
      "2031-06-16T10:00:00.000Z",
    );
  });

  it("round-trips and refuses what it doesn't support, in words", () => {
    expect(formatRule(parseRule("rrule:freq=weekly;byday=su,sa;interval=2"))).toBe(
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=SA,SU",
    );
    for (const [rule, message] of [
      ["FREQ=HOURLY", /DAILY, WEEKLY or MONTHLY/],
      ["FREQ=DAILY;BYDAY=MO", /WEEKLY only/],
      ["FREQ=WEEKLY;BYDAY=XX", /not a weekday/],
      ["FREQ=DAILY;COUNT=0", /whole number from 1/],
      ["FREQ=DAILY;COUNT=2;UNTIL=20270101", /not both/],
      ["FREQ=DAILY;BYSETPOS=1", /not supported/],
      ["FREQ=DAILY;UNTIL=tomorrow", /UNTIL must look like/],
      ["DAILY", /NAME=value/],
    ] as const) {
      expect(() => parseRule(rule), rule).toThrow(RecurrenceError);
      expect(() => parseRule(rule), rule).toThrow(message);
    }
  });
});
