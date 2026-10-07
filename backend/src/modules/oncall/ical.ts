/*
 * A minimal iCalendar (RFC 5545) writer for on-call feeds: UTC events, text escaped, lines ended
 * with CRLF and folded at 75 octets so strict clients accept it.
 */
export interface CalendarEvent {
  uid: string;
  startsAt: Date;
  endsAt: Date;
  summary: string;
  description?: string | undefined;
}

const stamp = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

const escapeText = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/* Folds one content line: at most 75 octets, continuation lines start with a space. */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    /* Never cut inside a multi-byte character. */
    while (end < bytes.length && ((bytes[end] as number) & 0xc0) === 0x80) end -= 1;
    parts.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    limit = 74;
  }
  return parts.join("\r\n ");
}

export function toICalendar(input: { name: string; now: Date; events: CalendarEvent[] }): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Watchpost//On-call//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(input.name)}`,
    /* Ask clients to refresh hourly; most pick their own interval anyway. */
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  for (const event of input.events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.uid}`,
      `DTSTAMP:${stamp(input.now)}`,
      `DTSTART:${stamp(event.startsAt)}`,
      `DTEND:${stamp(event.endsAt)}`,
      `SUMMARY:${escapeText(event.summary)}`,
      ...(event.description === undefined ? [] : [`DESCRIPTION:${escapeText(event.description)}`]),
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
