/*
 * Who is on call (PRODUCT.md §9.5). Pure functions over Luxon: evaluate layers (the higher one
 * wins), apply restrictions, then overrides.
 *
 * Daylight saving: daily and weekly rotations hand off at the wall-clock time of the first handoff,
 * in the schedule's timezone, so "Mondays 09:00" stays 09:00 local when the clocks change and a
 * shift across the change is an hour shorter or longer. Custom rotations count real hours.
 * Restriction windows are wall-clock too. A local time that doesn't exist on the night the clocks go
 * forward moves to the next minute that does (Luxon's rule).
 */
import { DateTime, IANAZone } from "luxon";
import type { Restriction, Rotation } from "@app/shared";

export interface EngineLayer {
  id: string;
  name: string;
  rotation: Rotation;
  /* Custom rotations only. */
  shiftHours: number | null;
  startsAt: Date;
  endsAt: Date | null;
  participants: string[];
  restrictions: Restriction[];
}

export interface EngineOverride {
  id: string;
  userId: string;
  startsAt: Date;
  endsAt: Date;
  createdAt: Date;
}

export interface EngineSchedule {
  timezone: string;
  /* Lowest first: a later layer wins over an earlier one. */
  layers: EngineLayer[];
  overrides: EngineOverride[];
}

export interface OnCallResult {
  userId: string;
  source: "override" | "layer";
  layerId: string | null;
  layerName: string | null;
}

export interface EngineSegment {
  startsAt: Date;
  endsAt: Date;
  onCall: OnCallResult | null;
}

export function isTimezone(value: string): boolean {
  return IANAZone.isValidZone(value);
}

const local = (at: Date, zone: string) => DateTime.fromJSDate(at, { zone });

/* The start of the layer's shift number `k`, counted from its first handoff. */
function shiftStart(layer: EngineLayer, zone: string, k: number): DateTime {
  const anchor = local(layer.startsAt, zone);
  if (layer.rotation === "custom") {
    return DateTime.fromMillis(anchor.toMillis() + k * (layer.shiftHours ?? 24) * 3_600_000, {
      zone,
    });
  }
  return anchor.plus({ days: k * (layer.rotation === "weekly" ? 7 : 1) });
}

/* Which shift of the layer contains `at`; negative before the first handoff. */
function shiftIndex(layer: EngineLayer, zone: string, at: Date): number {
  const ms = at.getTime();
  const approxLength =
    layer.rotation === "custom"
      ? (layer.shiftHours ?? 24) * 3_600_000
      : (layer.rotation === "weekly" ? 7 : 1) * 86_400_000;
  /* Close to right; the two loops settle the hour a clock change can move a handoff by. */
  let k = Math.floor((ms - layer.startsAt.getTime()) / approxLength);
  while (shiftStart(layer, zone, k + 1).toMillis() <= ms) k += 1;
  while (shiftStart(layer, zone, k).toMillis() > ms) k -= 1;
  return k;
}

const minutesOf = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/* True when no windows are set, or `at` falls inside one of them. */
function insideRestrictions(restrictions: Restriction[], zone: string, at: Date): boolean {
  if (restrictions.length === 0) return true;
  const now = local(at, zone);
  const minute = now.hour * 60 + now.minute;
  const today = now.weekday;
  const yesterday = today === 1 ? 7 : today - 1;
  return restrictions.some((r) => {
    const start = minutesOf(r.start);
    const end = minutesOf(r.end);
    if (end > start) return r.days.includes(today) && minute >= start && minute < end;
    /* Past midnight: the evening part belongs to its start day, the morning part to the day before. */
    return (
      (r.days.includes(today) && minute >= start) || (r.days.includes(yesterday) && minute < end)
    );
  });
}

function layerOnCall(layer: EngineLayer, zone: string, at: Date): string | undefined {
  const ms = at.getTime();
  if (ms < layer.startsAt.getTime()) return undefined;
  if (layer.endsAt !== null && ms >= layer.endsAt.getTime()) return undefined;
  if (layer.participants.length === 0) return undefined;
  if (!insideRestrictions(layer.restrictions, zone, at)) return undefined;
  const k = shiftIndex(layer, zone, at);
  return layer.participants[k % layer.participants.length];
}

export function whoIsOnCall(schedule: EngineSchedule, at: Date): OnCallResult | null {
  const ms = at.getTime();
  const override = schedule.overrides
    .filter((o) => o.startsAt.getTime() <= ms && ms < o.endsAt.getTime())
    /* Where overrides overlap, the one made last wins. */
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))[0];
  if (override !== undefined) {
    return { userId: override.userId, source: "override", layerId: null, layerName: null };
  }
  for (let i = schedule.layers.length - 1; i >= 0; i -= 1) {
    const layer = schedule.layers[i] as EngineLayer;
    const userId = layerOnCall(layer, schedule.timezone, at);
    if (userId !== undefined) {
      return { userId, source: "layer", layerId: layer.id, layerName: layer.name };
    }
  }
  return null;
}

/* Every instant in (from, to) at which the answer may change. */
function boundaries(schedule: EngineSchedule, from: Date, to: Date): number[] {
  const zone = schedule.timezone;
  const lo = from.getTime();
  const hi = to.getTime();
  const points = new Set<number>();
  const add = (ms: number) => {
    if (ms > lo && ms < hi) points.add(ms);
  };
  for (const o of schedule.overrides) {
    add(o.startsAt.getTime());
    add(o.endsAt.getTime());
  }
  for (const layer of schedule.layers) {
    add(layer.startsAt.getTime());
    if (layer.endsAt !== null) add(layer.endsAt.getTime());
    const first = Math.max(0, shiftIndex(layer, zone, from));
    for (let k = first; ; k += 1) {
      const start = shiftStart(layer, zone, k).toMillis();
      if (start >= hi) break;
      add(start);
    }
    if (layer.restrictions.length === 0) continue;
    /* A day early and a day late, so windows that run past midnight are covered. */
    let day = local(from, zone).startOf("day").minus({ days: 1 });
    const lastDay = local(to, zone).startOf("day").plus({ days: 1 });
    for (; day <= lastDay; day = day.plus({ days: 1 })) {
      for (const r of layer.restrictions) {
        for (const clock of [r.start, r.end]) {
          const minutes = minutesOf(clock);
          add(day.set({ hour: Math.floor(minutes / 60), minute: minutes % 60 }).toMillis());
        }
      }
    }
  }
  return [...points].sort((a, b) => a - b);
}

const same = (a: OnCallResult | null, b: OnCallResult | null) =>
  a === null || b === null
    ? a === b
    : a.userId === b.userId && a.source === b.source && a.layerId === b.layerId;

/* The stretches between `from` and `to`, in order and without gaps; neighbours always differ. */
export function timeline(schedule: EngineSchedule, from: Date, to: Date): EngineSegment[] {
  if (to.getTime() <= from.getTime()) return [];
  const cuts = [from.getTime(), ...boundaries(schedule, from, to), to.getTime()];
  const segments: EngineSegment[] = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const startsAt = new Date(cuts[i] as number);
    const endsAt = new Date(cuts[i + 1] as number);
    const onCall = whoIsOnCall(schedule, startsAt);
    const previous = segments.at(-1);
    if (previous !== undefined && same(previous.onCall, onCall)) previous.endsAt = endsAt;
    else segments.push({ startsAt, endsAt, onCall });
  }
  return segments;
}
