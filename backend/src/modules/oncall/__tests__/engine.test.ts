/*
 * P4-T03 AC: who is on call across daylight-saving changes (America/New_York, Europe/Berlin), in a
 * zone without them (Asia/Karachi), with restrictions, layers and overrides; and the timeline agrees
 * with `whoIsOnCall` at random instants.
 */
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  timeline,
  whoIsOnCall,
  type EngineLayer,
  type EngineOverride,
  type EngineSchedule,
} from "../engine.js";

const A = "user-a";
const B = "user-b";
const C = "user-c";

const at = (iso: string, zone: string) => DateTime.fromISO(iso, { zone }).toJSDate();
const utc = (iso: string) => new Date(iso);

function layer(patch: Partial<EngineLayer> & Pick<EngineLayer, "startsAt">): EngineLayer {
  return {
    id: "layer-1",
    name: "Primary",
    rotation: "weekly",
    shiftHours: null,
    endsAt: null,
    participants: [A, B],
    restrictions: [],
    ...patch,
  };
}

const schedule = (
  timezone: string,
  layers: EngineLayer[],
  overrides: EngineOverride[] = [],
): EngineSchedule => ({ timezone, layers, overrides });

const who = (s: EngineSchedule, when: Date) => whoIsOnCall(s, when)?.userId ?? null;

describe("rotations", () => {
  it("rotates weekly from the first handoff and wraps around", () => {
    const zone = "Asia/Karachi";
    const s = schedule(zone, [
      layer({ startsAt: at("2026-06-01T09:00", zone), participants: [A, B, C] }),
    ]);
    expect(who(s, at("2026-06-01T08:59", zone))).toBeNull();
    expect(who(s, at("2026-06-01T09:00", zone))).toBe(A);
    expect(who(s, at("2026-06-08T08:59", zone))).toBe(A);
    expect(who(s, at("2026-06-08T09:00", zone))).toBe(B);
    expect(who(s, at("2026-06-15T09:00", zone))).toBe(C);
    expect(who(s, at("2026-06-22T09:00", zone))).toBe(A);
  });

  it("rotates daily and by a custom number of hours", () => {
    const zone = "Asia/Karachi";
    const daily = schedule(zone, [
      layer({ rotation: "daily", startsAt: at("2026-06-01T09:00", zone) }),
    ]);
    expect(who(daily, at("2026-06-01T23:00", zone))).toBe(A);
    expect(who(daily, at("2026-06-02T09:00", zone))).toBe(B);
    expect(who(daily, at("2026-06-03T09:00", zone))).toBe(A);

    const twelve = schedule(zone, [
      layer({ rotation: "custom", shiftHours: 12, startsAt: at("2026-06-01T09:00", zone) }),
    ]);
    expect(who(twelve, at("2026-06-01T20:59", zone))).toBe(A);
    expect(who(twelve, at("2026-06-01T21:00", zone))).toBe(B);
    expect(who(twelve, at("2026-06-02T09:00", zone))).toBe(A);
  });

  it("stops at the layer's end", () => {
    const zone = "Asia/Karachi";
    const s = schedule(zone, [
      layer({ startsAt: at("2026-06-01T09:00", zone), endsAt: at("2026-06-10T09:00", zone) }),
    ]);
    expect(who(s, at("2026-06-10T08:59", zone))).toBe(B);
    expect(who(s, at("2026-06-10T09:00", zone))).toBeNull();
  });
});

describe("daylight saving", () => {
  it("keeps a weekly 09:00 handoff at 09:00 local in New York when clocks go back", () => {
    const zone = "America/New_York";
    /* Clocks go back on Sunday 2026-11-01; the handoff on Monday the 2nd is at 14:00 UTC, not 13:00. */
    const s = schedule(zone, [layer({ startsAt: at("2026-10-26T09:00", zone) })]);
    expect(at("2026-10-26T09:00", zone).toISOString()).toBe("2026-10-26T13:00:00.000Z");
    expect(who(s, utc("2026-11-02T13:30:00Z"))).toBe(A);
    expect(who(s, utc("2026-11-02T13:59:59Z"))).toBe(A);
    expect(who(s, utc("2026-11-02T14:00:00Z"))).toBe(B);
    expect(who(s, at("2026-11-09T09:00", zone))).toBe(A);
  });

  it("keeps a weekly 09:00 handoff at 09:00 local in New York when clocks go forward", () => {
    const zone = "America/New_York";
    /* Clocks go forward on Sunday 2026-03-08; Monday's handoff moves from 14:00 UTC to 13:00 UTC. */
    const s = schedule(zone, [layer({ startsAt: at("2026-03-02T09:00", zone) })]);
    expect(at("2026-03-02T09:00", zone).toISOString()).toBe("2026-03-02T14:00:00.000Z");
    expect(who(s, utc("2026-03-09T12:59:59Z"))).toBe(A);
    expect(who(s, utc("2026-03-09T13:00:00Z"))).toBe(B);
  });

  it("keeps a daily handoff on the wall clock in Berlin on both change days", () => {
    const zone = "Europe/Berlin";
    const spring = schedule(zone, [
      layer({ rotation: "daily", startsAt: at("2026-03-28T08:00", zone), participants: [A, B, C] }),
    ]);
    /* 2026-03-29 has 23 hours in Berlin: the shift that spans it is an hour shorter. */
    expect(who(spring, at("2026-03-29T07:59", zone))).toBe(A);
    expect(who(spring, at("2026-03-29T08:00", zone))).toBe(B);
    expect(who(spring, at("2026-03-30T08:00", zone))).toBe(C);
    expect(at("2026-03-29T08:00", zone).getTime() - at("2026-03-28T08:00", zone).getTime()).toBe(
      23 * 3_600_000,
    );

    const autumn = schedule(zone, [
      layer({ rotation: "daily", startsAt: at("2026-10-24T08:00", zone), participants: [A, B, C] }),
    ]);
    /* 2026-10-25 has 25 hours in Berlin. */
    expect(who(autumn, at("2026-10-25T07:59", zone))).toBe(A);
    expect(who(autumn, at("2026-10-25T08:00", zone))).toBe(B);
    expect(who(autumn, at("2026-10-26T08:00", zone))).toBe(C);
  });

  it("counts real hours for a custom rotation across a change", () => {
    const zone = "Europe/Berlin";
    const s = schedule(zone, [
      layer({ rotation: "custom", shiftHours: 24, startsAt: at("2026-10-24T08:00", zone) }),
    ]);
    /* 24 real hours after 08:00 on the 24th is 07:00 local on the 25th (the day has 25 hours). */
    expect(who(s, at("2026-10-25T06:59", zone))).toBe(A);
    expect(who(s, at("2026-10-25T07:00", zone))).toBe(B);
  });

  it("never shifts in Karachi, which has no daylight saving", () => {
    const zone = "Asia/Karachi";
    const s = schedule(zone, [
      layer({ rotation: "daily", startsAt: at("2026-01-01T09:00", zone) }),
    ]);
    for (const day of ["2026-03-08", "2026-03-29", "2026-10-25", "2026-11-01"]) {
      const handoff = at(`${day}T09:00`, zone);
      expect(handoff.toISOString().slice(11, 16)).toBe("04:00");
      expect(who(s, new Date(handoff.getTime() - 1))).not.toBe(who(s, handoff));
    }
  });
});

describe("restrictions", () => {
  const zone = "America/New_York";
  const weekdays = { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" };

  it("puts the layer on call only inside its windows", () => {
    /* 2026-06-01 is a Monday. */
    const s = schedule(zone, [
      layer({ startsAt: at("2026-06-01T00:00", zone), restrictions: [weekdays] }),
    ]);
    expect(who(s, at("2026-06-01T08:59", zone))).toBeNull();
    expect(who(s, at("2026-06-01T09:00", zone))).toBe(A);
    expect(who(s, at("2026-06-01T17:59", zone))).toBe(A);
    expect(who(s, at("2026-06-01T18:00", zone))).toBeNull();
    expect(who(s, at("2026-06-06T12:00", zone))).toBeNull();
  });

  it("follows the wall clock across a change", () => {
    const s = schedule(zone, [
      layer({ startsAt: at("2026-10-26T00:00", zone), restrictions: [weekdays] }),
    ]);
    /* Monday after the clocks went back: 09:00 local is 14:00 UTC. */
    expect(who(s, utc("2026-11-02T13:59:00Z"))).toBeNull();
    expect(who(s, utc("2026-11-02T14:00:00Z"))).toBe(B);
  });

  it("runs a window past midnight from its start day", () => {
    const nights = { days: [5], start: "22:00", end: "06:00" };
    const s = schedule(zone, [
      layer({ startsAt: at("2026-06-01T00:00", zone), restrictions: [nights] }),
    ]);
    /* Friday 2026-06-05 22:00 to Saturday 06:00. */
    expect(who(s, at("2026-06-05T21:59", zone))).toBeNull();
    expect(who(s, at("2026-06-05T22:00", zone))).toBe(A);
    expect(who(s, at("2026-06-06T05:59", zone))).toBe(A);
    expect(who(s, at("2026-06-06T06:00", zone))).toBeNull();
    expect(who(s, at("2026-06-06T23:00", zone))).toBeNull();
  });
});

describe("layers and overrides", () => {
  const zone = "Europe/Berlin";
  const base = layer({ id: "base", name: "Everyone", startsAt: at("2026-06-01T00:00", zone) });
  const business = layer({
    id: "business",
    name: "Business hours",
    startsAt: at("2026-06-01T00:00", zone),
    participants: [C],
    restrictions: [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }],
  });

  it("lets the higher layer win and falls through to the lower one outside its windows", () => {
    const s = schedule(zone, [base, business]);
    expect(whoIsOnCall(s, at("2026-06-02T10:00", zone))).toMatchObject({
      userId: C,
      source: "layer",
      layerId: "business",
    });
    expect(whoIsOnCall(s, at("2026-06-02T20:00", zone))).toMatchObject({
      userId: A,
      layerId: "base",
    });
  });

  it("lets an override win over every layer, and the newer of two overrides", () => {
    const first: EngineOverride = {
      id: "o1",
      userId: B,
      startsAt: at("2026-06-02T09:00", zone),
      endsAt: at("2026-06-02T12:00", zone),
      createdAt: utc("2026-05-01T00:00:00Z"),
    };
    const second: EngineOverride = {
      ...first,
      id: "o2",
      userId: A,
      startsAt: at("2026-06-02T11:00", zone),
      endsAt: at("2026-06-02T13:00", zone),
      createdAt: utc("2026-05-02T00:00:00Z"),
    };
    const s = schedule(zone, [base, business], [first, second]);
    expect(whoIsOnCall(s, at("2026-06-02T10:00", zone))).toMatchObject({
      userId: B,
      source: "override",
    });
    expect(who(s, at("2026-06-02T11:30", zone))).toBe(A);
    expect(who(s, at("2026-06-02T13:00", zone))).toBe(C);
  });
});

describe("timeline", () => {
  const zone = "America/New_York";
  const s = schedule(
    zone,
    [
      layer({
        id: "base",
        rotation: "daily",
        startsAt: at("2026-10-20T09:00", zone),
        participants: [A, B, C],
      }),
      layer({
        id: "business",
        name: "Business hours",
        startsAt: at("2026-10-19T00:00", zone),
        participants: [C, A],
        restrictions: [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }],
      }),
    ],
    [
      {
        id: "o1",
        userId: B,
        startsAt: at("2026-10-28T12:00", zone),
        endsAt: at("2026-10-29T12:00", zone),
        createdAt: utc("2026-10-01T00:00:00Z"),
      },
    ],
  );
  const from = at("2026-10-18T00:00", zone);
  const to = at("2026-11-10T00:00", zone);
  const segments = timeline(s, from, to);

  it("covers the range without gaps, and neighbours differ", () => {
    expect(segments[0]?.startsAt.getTime()).toBe(from.getTime());
    expect(segments.at(-1)?.endsAt.getTime()).toBe(to.getTime());
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i]?.startsAt.getTime()).toBe(segments[i - 1]?.endsAt.getTime());
      const key = (x: (typeof segments)[number] | undefined) =>
        `${x?.onCall?.userId ?? "nobody"}/${x?.onCall?.source ?? ""}/${x?.onCall?.layerId ?? ""}`;
      expect(key(segments[i])).not.toBe(key(segments[i - 1]));
    }
    expect(segments[0]?.onCall).toBeNull();
  });

  it("agrees with whoIsOnCall at 30 random instants and at every boundary", () => {
    /* A fixed seed, so a failure can be reproduced. */
    let seed = 20261006;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const span = to.getTime() - from.getTime();
    const instants = Array.from(
      { length: 30 },
      () => new Date(from.getTime() + Math.floor(random() * span)),
    );
    for (const seg of segments) {
      instants.push(seg.startsAt, new Date(seg.endsAt.getTime() - 1));
    }
    for (const instant of instants) {
      const seg = segments.find(
        (x) => x.startsAt.getTime() <= instant.getTime() && instant.getTime() < x.endsAt.getTime(),
      );
      expect(seg?.onCall?.userId ?? null, instant.toISOString()).toBe(who(s, instant));
    }
  });

  it("returns nothing for an empty range", () => {
    expect(timeline(s, to, from)).toEqual([]);
  });
});
