/* P4-T03b AC: the calendar shows the same person the API's timeline names, on 30 random dates. */
import { describe, expect, it } from "vitest";
import type { OnCallSegment } from "@app/shared";
import {
  blockAt,
  calendarDays,
  calendarRange,
  localDate,
  localDayStart,
  nextLocalMidnight,
} from "../calendar";

const zone = "America/New_York";
const person = (userId: string) => ({ userId, name: userId.toUpperCase() });

/* A weekly rotation with a handoff on Mondays 09:00 New York time, across the November clock change. */
const segments: OnCallSegment[] = [
  ["2026-10-19T04:00:00Z", "2026-10-26T13:00:00Z", "a"],
  ["2026-10-26T13:00:00Z", "2026-11-02T14:00:00Z", "b"],
  ["2026-11-02T14:00:00Z", "2026-11-09T14:00:00Z", "a"],
  ["2026-11-09T14:00:00Z", "2026-11-16T05:00:00Z", "b"],
].map(([startsAt, endsAt, user]) => ({
  startsAt: startsAt as string,
  endsAt: endsAt as string,
  user: person(user as string),
  source: "layer" as const,
  layerName: "Weekly",
}));

describe("local days", () => {
  it("finds midnights in the schedule's zone, on short and long days too", () => {
    const noon = Date.parse("2026-11-01T16:00:00Z");
    expect(localDate(noon, zone)).toBe("2026-11-01");
    const start = localDayStart(noon, zone);
    const end = nextLocalMidnight(noon, zone);
    expect(new Date(start).toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(new Date(end).toISOString()).toBe("2026-11-02T05:00:00.000Z");
    /* The day the clocks go back has 25 hours. */
    expect(end - start).toBe(25 * 3_600_000);

    const spring = Date.parse("2026-03-08T16:00:00Z");
    expect(nextLocalMidnight(spring, zone) - localDayStart(spring, zone)).toBe(23 * 3_600_000);
  });

  it("asks the API for whole local days", () => {
    const range = calendarRange(zone, Date.parse("2026-10-19T15:00:00Z"), 28);
    expect(new Date(range.from).toISOString()).toBe("2026-10-19T04:00:00.000Z");
    expect(new Date(range.to).toISOString()).toBe("2026-11-16T05:00:00.000Z");
  });
});

describe("calendarDays", () => {
  const from = Date.parse("2026-10-19T15:00:00Z");
  const days = calendarDays(segments, zone, from, 28);

  it("makes one entry per local day and splits a handoff day in two", () => {
    expect(days).toHaveLength(28);
    expect(days[0]?.date).toBe("2026-10-19");
    expect(days.at(-1)?.date).toBe("2026-11-15");
    const handoff = days.find((d) => d.date === "2026-10-26");
    expect(handoff?.blocks.map((b) => b.userId)).toEqual(["a", "b"]);
    expect(days.find((d) => d.date === "2026-10-27")?.blocks.map((b) => b.userId)).toEqual(["b"]);
  });

  it("covers every day without gaps", () => {
    for (const day of days) {
      expect(day.blocks[0]?.startsAt).toBe(day.startsAt);
      expect(day.blocks.at(-1)?.endsAt).toBe(day.endsAt);
      for (let i = 1; i < day.blocks.length; i += 1) {
        expect(day.blocks[i]?.startsAt).toBe(day.blocks[i - 1]?.endsAt);
      }
    }
  });

  it("matches the API timeline on 30 random dates", () => {
    let seed = 4_820_301;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const lo = days[0]?.startsAt ?? 0;
    const hi = days.at(-1)?.endsAt ?? 0;
    for (let i = 0; i < 30; i += 1) {
      const instant = lo + Math.floor(random() * (hi - lo));
      const segment = segments.find(
        (s) => Date.parse(s.startsAt) <= instant && instant < Date.parse(s.endsAt),
      );
      expect(blockAt(days, instant)?.userId, new Date(instant).toISOString()).toBe(
        segment?.user?.userId,
      );
    }
    expect(blockAt(days, lo - 1)).toBeUndefined();
  });
});
