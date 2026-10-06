/*
 * P1-T16 AC: uptime math matches hand-computed fixtures. Each case states its arithmetic.
 */
import { describe, expect, it } from "vitest";
import { computeUptime, uptimeDays, type DowntimeSpan } from "../uptime.js";

const t = (hhmm: string, day = "2026-10-01") => new Date(`${day}T${hhmm}:00Z`);
const DAY_START = t("00:00");
const DAY_END = t("00:00", "2026-10-02");
const outage = (from: Date, to: Date | null): DowntimeSpan => ({
  kind: "outage",
  startedAt: from,
  endedAt: to,
});

const base = {
  from: DAY_START,
  to: DAY_END,
  now: t("12:00", "2026-10-05"),
  since: t("00:00", "2026-01-01"),
  excludeMaintenance: false,
};

describe("uptime fixtures", () => {
  it("a whole day with no downtime is 100 %", () => {
    expect(computeUptime({ ...base, spans: [] })).toMatchObject({
      rangeSeconds: 86_400,
      downtimeSeconds: 0,
      uptimePercent: 100,
    });
  });

  it("a 30-minute outage in a day: 1 − 1800 / 86400 = 97.9167 %", () => {
    expect(computeUptime({ ...base, spans: [outage(t("01:00"), t("01:30"))] })).toMatchObject({
      downtimeSeconds: 1_800,
      uptimePercent: 97.9167,
    });
  });

  it("an outage still open counts until now, and the range ends now: 1 − 1800 / 84600 = 97.8723 %", () => {
    const summary = computeUptime({
      ...base,
      now: t("23:30"),
      spans: [outage(t("23:00"), null)],
    });
    expect(summary).toMatchObject({
      rangeSeconds: 84_600,
      downtimeSeconds: 1_800,
      uptimePercent: 97.8723,
    });
  });

  it("maintenance counts as downtime unless excluded", () => {
    const spans: DowntimeSpan[] = [
      outage(t("01:00"), t("01:30")),
      { kind: "maintenance", startedAt: t("02:00"), endedAt: t("03:00") },
    ];
    /* Counted: 1 − (1800 + 3600) / 86400 = 93.75 %. */
    expect(computeUptime({ ...base, spans })).toMatchObject({
      downtimeSeconds: 5_400,
      maintenanceSeconds: 3_600,
      uptimePercent: 93.75,
    });
    /* Excluded: 1 − 1800 / (86400 − 3600) = 97.8261 %. */
    expect(computeUptime({ ...base, spans, excludeMaintenance: true })).toMatchObject({
      downtimeSeconds: 1_800,
      uptimePercent: 97.8261,
    });
  });

  it("degraded time is reported but is not downtime", () => {
    expect(
      computeUptime({
        ...base,
        spans: [{ kind: "degraded", startedAt: t("04:00"), endedAt: t("05:00") }],
      }),
    ).toMatchObject({ degradedSeconds: 3_600, downtimeSeconds: 0, uptimePercent: 100 });
  });

  it("time before the monitor existed is outside the range: 1 − 2160 / 43200 = 95 %", () => {
    expect(
      computeUptime({ ...base, since: t("12:00"), spans: [outage(t("13:00"), t("13:36"))] }),
    ).toMatchObject({ rangeSeconds: 43_200, downtimeSeconds: 2_160, uptimePercent: 95 });
  });

  it("outages crossing the range edges are clipped: 1 − 600 / 86400 = 99.3056 %", () => {
    const spans = [
      outage(t("23:55", "2026-09-30"), t("00:05")),
      outage(t("23:55"), t("00:10", "2026-10-02")),
    ];
    expect(computeUptime({ ...base, spans })).toMatchObject({
      downtimeSeconds: 600,
      uptimePercent: 99.3056,
    });
  });

  it("a range entirely before the monitor existed has no uptime", () => {
    expect(computeUptime({ ...base, since: t("00:00", "2026-10-03"), spans: [] })).toMatchObject({
      rangeSeconds: 0,
      uptimePercent: null,
    });
  });
});

describe("uptime day bars", () => {
  it("colors days by the thresholds and leaves days before creation empty", () => {
    const days = uptimeDays({
      days: 4,
      now: t("12:00", "2026-10-04"),
      since: t("00:00", "2026-10-02"),
      excludeMaintenance: false,
      spans: [
        /* 2 Oct: 60 s → 99.9306 % (≥ 99.9, up). */
        outage(t("10:00", "2026-10-02"), t("10:01", "2026-10-02")),
        /* 3 Oct: 600 s → 99.3056 % (≥ 99, minor). */
        outage(t("10:00", "2026-10-03"), t("10:10", "2026-10-03")),
        /* 4 Oct until noon: 3600 s of 43200 → 91.6667 % (major). */
        outage(t("06:00", "2026-10-04"), t("07:00", "2026-10-04")),
      ],
    });
    expect(days).toEqual([
      { date: "2026-10-01", uptimePercent: null, downtimeSeconds: 0, status: "none" },
      { date: "2026-10-02", uptimePercent: 99.9306, downtimeSeconds: 60, status: "up" },
      { date: "2026-10-03", uptimePercent: 99.3056, downtimeSeconds: 600, status: "minor" },
      { date: "2026-10-04", uptimePercent: 91.6667, downtimeSeconds: 3_600, status: "major" },
    ]);
  });
});
