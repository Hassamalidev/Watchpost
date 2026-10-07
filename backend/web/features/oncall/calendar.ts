/*
 * Turns the API's on-call timeline into calendar days in the schedule's time zone. Pure; the day
 * boundaries come from Intl, so a 23- or 25-hour day on a clock change is still one day.
 */
import type { OnCallSegment } from "@app/shared";

export interface CalendarBlock {
  startsAt: number;
  endsAt: number;
  userId: string | null;
  name: string | null;
  source: OnCallSegment["source"];
  layerName: string | null;
}

export interface CalendarDay {
  /* YYYY-MM-DD in the schedule's time zone. */
  date: string;
  startsAt: number;
  endsAt: number;
  blocks: CalendarBlock[];
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/* YYYY-MM-DD of an instant in a time zone. */
export function localDate(ms: number, timeZone: string): string {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter.format(new Date(ms));
}

/* The first instant after `ms` at which the local date changes. */
export function nextLocalMidnight(ms: number, timeZone: string): number {
  const today = localDate(ms, timeZone);
  let lo = ms;
  /* No local day is longer than 25 hours. */
  let hi = ms + 26 * 3_600_000;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (localDate(mid, timeZone) === today) lo = mid;
    else hi = mid;
  }
  return hi;
}

/* The local midnight that starts the day containing `ms`. */
export function localDayStart(ms: number, timeZone: string): number {
  const today = localDate(ms, timeZone);
  let hi = ms;
  let lo = ms - 26 * 3_600_000;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (localDate(mid, timeZone) === today) hi = mid;
    else lo = mid;
  }
  return hi;
}

/* `days` calendar days from the one containing `from`, each with the stretches that fall in it. */
export function calendarDays(
  segments: readonly OnCallSegment[],
  timeZone: string,
  from: number,
  days: number,
): CalendarDay[] {
  const out: CalendarDay[] = [];
  let dayStart = localDayStart(from, timeZone);
  for (let i = 0; i < days; i += 1) {
    const dayEnd = nextLocalMidnight(dayStart, timeZone);
    const blocks: CalendarBlock[] = [];
    for (const segment of segments) {
      const startsAt = Math.max(Date.parse(segment.startsAt), dayStart);
      const endsAt = Math.min(Date.parse(segment.endsAt), dayEnd);
      if (endsAt <= startsAt) continue;
      blocks.push({
        startsAt,
        endsAt,
        userId: segment.user?.userId ?? null,
        name: segment.user?.name ?? null,
        source: segment.source,
        layerName: segment.layerName,
      });
    }
    out.push({ date: localDate(dayStart, timeZone), startsAt: dayStart, endsAt: dayEnd, blocks });
    dayStart = dayEnd;
  }
  return out;
}

/* The block a calendar shows for an instant, if the calendar covers it. */
export function blockAt(days: readonly CalendarDay[], ms: number): CalendarBlock | undefined {
  for (const day of days) {
    if (ms < day.startsAt || ms >= day.endsAt) continue;
    return day.blocks.find((block) => block.startsAt <= ms && ms < block.endsAt);
  }
  return undefined;
}

/* The range to ask the API for: `days` local days from the day containing `from`. */
export function calendarRange(
  timeZone: string,
  from: number,
  days: number,
): { from: number; to: number } {
  const start = localDayStart(from, timeZone);
  let end = start;
  for (let i = 0; i < days; i += 1) end = nextLocalMidnight(end, timeZone);
  return { from: start, to: end };
}

/* A `datetime-local` value (browser time) as an ISO instant, or undefined when it is empty or bad. */
export function localInputToIso(value: string): string | undefined {
  const date = new Date(value);
  return value === "" || Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/* An instant as a `datetime-local` value in the browser's time zone. */
export function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
