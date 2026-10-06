/*
 * When a maintenance window is in effect (PRODUCT.md §9.6). A window has a first occurrence
 * (`startsAt` to `endsAt`), a timezone and, when it repeats, a rule. Pure functions over Luxon.
 *
 * The rule is a small part of RFC 5545's RRULE, enough for "every night", "every second Sunday" and
 * "the first of the month": FREQ=DAILY|WEEKLY|MONTHLY, INTERVAL, BYDAY (weekly only), COUNT, UNTIL.
 *
 * Daylight saving: an occurrence starts at the same wall-clock time as the first one, in the
 * window's timezone, and lasts as long as the first one did. "Sundays 02:00 for two hours" stays at
 * 02:00 local when the clocks change, so its UTC time moves by an hour. On the one night a year
 * when that local time doesn't exist, it starts at the next minute that does.
 */
import { DateTime, IANAZone } from "luxon";

export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface RecurrenceRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY";
  interval: number;
  /* Weekly rules only; empty means the weekday of the first occurrence. */
  byDay: Weekday[];
  count: number | null;
  until: Date | null;
}

export interface WindowSpec {
  startsAt: Date;
  endsAt: Date;
  rrule: string | null;
  timezone: string;
}

export interface Occurrence {
  start: Date;
  end: Date;
}

export class RecurrenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecurrenceError";
  }
}

export const MAX_COUNT = 1_000;
export const MAX_INTERVAL = 366;
/* A guard against rules that would loop for ever while looking for an occurrence. */
const MAX_STEPS = 20_000;

export const isValidTimezone = (zone: string) => IANAZone.isValidZone(zone);

/* "FREQ=WEEKLY;INTERVAL=2;BYDAY=SA,SU" → a rule. Throws RecurrenceError with a message for people. */
export function parseRule(text: string): RecurrenceRule {
  const parts = new Map<string, string>();
  for (const part of text.replace(/^RRULE:/i, "").split(";")) {
    if (part.trim() === "") continue;
    const [key, value] = part.split("=");
    if (key === undefined || value === undefined || value === "") {
      throw new RecurrenceError(`"${part}" is not a NAME=value pair.`);
    }
    parts.set(key.trim().toUpperCase(), value.trim().toUpperCase());
  }
  const known = new Set(["FREQ", "INTERVAL", "BYDAY", "COUNT", "UNTIL"]);
  for (const key of parts.keys()) {
    if (!known.has(key)) throw new RecurrenceError(`${key} is not supported in a repeat rule.`);
  }

  const freq = parts.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY") {
    throw new RecurrenceError("FREQ must be DAILY, WEEKLY or MONTHLY.");
  }
  const whole = (key: string, max: number): number | null => {
    const raw = parts.get(key);
    if (raw === undefined) return null;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > max) {
      throw new RecurrenceError(`${key} must be a whole number from 1 to ${max}.`);
    }
    return value;
  };
  const interval = whole("INTERVAL", MAX_INTERVAL) ?? 1;
  const count = whole("COUNT", MAX_COUNT);

  let byDay: Weekday[] = [];
  const rawDays = parts.get("BYDAY");
  if (rawDays !== undefined) {
    if (freq !== "WEEKLY") throw new RecurrenceError("BYDAY works with FREQ=WEEKLY only.");
    const days = rawDays.split(",").map((d) => d.trim());
    for (const day of days) {
      if (!(WEEKDAYS as readonly string[]).includes(day)) {
        throw new RecurrenceError(`"${day}" is not a weekday (MO, TU, WE, TH, FR, SA, SU).`);
      }
    }
    byDay = WEEKDAYS.filter((d) => days.includes(d));
  }

  let until: Date | null = null;
  const rawUntil = parts.get("UNTIL");
  if (rawUntil !== undefined) {
    if (count !== null) throw new RecurrenceError("Use COUNT or UNTIL, not both.");
    const parsed = /^\d{8}$/.test(rawUntil)
      ? DateTime.fromFormat(rawUntil, "yyyyMMdd", { zone: "utc" }).endOf("day")
      : DateTime.fromFormat(rawUntil, "yyyyMMdd'T'HHmmss'Z'", { zone: "utc" });
    if (!parsed.isValid) {
      throw new RecurrenceError("UNTIL must look like 20270131 or 20270131T235959Z.");
    }
    until = parsed.toJSDate();
  }
  return { freq, interval, byDay, count, until };
}

export function formatRule(rule: RecurrenceRule): string {
  return [
    `FREQ=${rule.freq}`,
    ...(rule.interval === 1 ? [] : [`INTERVAL=${rule.interval}`]),
    ...(rule.byDay.length === 0 ? [] : [`BYDAY=${rule.byDay.join(",")}`]),
    ...(rule.count === null ? [] : [`COUNT=${rule.count}`]),
    ...(rule.until === null
      ? []
      : [
          `UNTIL=${DateTime.fromJSDate(rule.until, { zone: "utc" }).toFormat("yyyyMMdd'T'HHmmss'Z'")}`,
        ]),
  ].join(";");
}

/* Occurrence starts in order, from the first one. Stops by itself only for COUNT and UNTIL. */
function* starts(first: DateTime, rule: RecurrenceRule, fromPeriod: number): Generator<DateTime> {
  for (let period = fromPeriod; ; period += 1) {
    const step = period * rule.interval;
    if (rule.freq === "DAILY") {
      yield first.plus({ days: step });
    } else if (rule.freq === "MONTHLY") {
      /* A day the month doesn't have (the 31st in April) falls on its last day. */
      yield first.plus({ months: step });
    } else if (rule.byDay.length === 0) {
      yield first.plus({ weeks: step });
    } else {
      /* Luxon weeks start on Monday, like WEEKDAYS. */
      const monday = first.startOf("week").plus({ weeks: step });
      for (const day of rule.byDay) {
        const at = monday.plus({ days: WEEKDAYS.indexOf(day) }).set({
          hour: first.hour,
          minute: first.minute,
          second: first.second,
          millisecond: first.millisecond,
        });
        if (at >= first) yield at;
      }
    }
  }
}

/*
 * Occurrences that overlap [from, to], in order. A window without a rule has exactly one.
 * `limit` caps the answer for calendar views.
 */
export function occurrencesBetween(
  spec: WindowSpec,
  from: Date,
  to: Date,
  limit = 500,
): Occurrence[] {
  const durationMs = spec.endsAt.getTime() - spec.startsAt.getTime();
  if (durationMs <= 0) return [];
  if (spec.rrule === null) {
    return spec.endsAt > from && spec.startsAt <= to
      ? [{ start: spec.startsAt, end: spec.endsAt }]
      : [];
  }
  const rule = parseRule(spec.rrule);
  const first = DateTime.fromJSDate(spec.startsAt, { zone: spec.timezone });
  if (!first.isValid) throw new RecurrenceError(`Unknown timezone "${spec.timezone}".`);

  /* Without COUNT the search can start near `from`; with it every occurrence has to be counted. */
  let fromPeriod = 0;
  if (rule.count === null) {
    const unit = rule.freq === "DAILY" ? "days" : rule.freq === "WEEKLY" ? "weeks" : "months";
    const target = DateTime.fromMillis(from.getTime() - durationMs, { zone: spec.timezone });
    const elapsed = Math.floor(target.diff(first, unit).as(unit) / rule.interval);
    fromPeriod = Math.max(0, elapsed - 1);
  }

  const found: Occurrence[] = [];
  let seen = 0;
  let steps = 0;
  for (const start of starts(first, rule, fromPeriod)) {
    steps += 1;
    if (steps > MAX_STEPS) break;
    seen += 1;
    if (rule.count !== null && seen > rule.count) break;
    const startMs = start.toMillis();
    if (rule.until !== null && startMs > rule.until.getTime()) break;
    if (startMs > to.getTime()) break;
    const endMs = startMs + durationMs;
    if (endMs > from.getTime()) {
      found.push({ start: new Date(startMs), end: new Date(endMs) });
      if (found.length >= limit) break;
    }
  }
  return found;
}

/* The occurrence in effect at `at`, if any. An occurrence includes its start and excludes its end. */
export function occurrenceAt(spec: WindowSpec, at: Date): Occurrence | null {
  const hit = occurrencesBetween(spec, at, at, 4).find((o) => o.start <= at && at < o.end);
  return hit ?? null;
}

/* The next occurrence that starts after `after`, within a year. */
export function nextOccurrence(spec: WindowSpec, after: Date): Occurrence | null {
  const horizon = new Date(after.getTime() + 366 * 86_400_000);
  return occurrencesBetween(spec, after, horizon, 8).find((o) => o.start > after) ?? null;
}

/* True once no occurrence can happen any more. */
export function isOver(spec: WindowSpec, at: Date): boolean {
  if (spec.rrule === null) return spec.endsAt <= at;
  return occurrenceAt(spec, at) === null && nextOccurrence(spec, at) === null;
}
