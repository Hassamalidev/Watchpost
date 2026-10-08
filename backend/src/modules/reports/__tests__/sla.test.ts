/* Periods, labels and files of SLA reports: the pure parts. */
import { describe, expect, it } from "vitest";
import type { SlaReport } from "@app/shared";
import { duePeriod, periodLabel, slaCsv, slaFileName, slaPdf } from "../sla.js";

const at = (iso: string) => new Date(iso);

const report: SlaReport = {
  workspaceName: "Acme",
  target: { kind: "group", id: "0199c1a0-0000-7000-8000-000000000001", name: "Shop" },
  from: "2026-09-01T00:00:00.000Z",
  to: "2026-10-01T00:00:00.000Z",
  excludeMaintenance: true,
  generatedAt: "2026-10-01T08:00:00.000Z",
  totals: {
    uptimePercent: 99.9306,
    rangeSeconds: 2_592_000,
    downtimeSeconds: 1_800,
    maintenanceSeconds: 0,
    incidents: 1,
    mttaSeconds: 120,
    mttrSeconds: 1_800,
    p50: 97.5,
    p95: 480,
    p99: null,
    checks: 8_640,
  },
  rows: [
    {
      monitorId: "0199c1a0-0000-7000-8000-000000000002",
      name: 'Shop, "main" site',
      type: "http",
      uptimePercent: 99.9306,
      rangeSeconds: 2_592_000,
      downtimeSeconds: 1_800,
      maintenanceSeconds: 0,
      incidents: 1,
      mttaSeconds: 120,
      mttrSeconds: 1_800,
      p50: 97.5,
      p95: 480,
      p99: null,
      checks: 8_640,
    },
  ],
  truncated: false,
};

describe("duePeriod", () => {
  it("is last month from 08:00 UTC on the 1st", () => {
    expect(duePeriod("monthly", at("2026-10-01T07:59:00Z"))).toBeUndefined();
    expect(duePeriod("monthly", at("2026-10-01T08:00:00Z"))).toEqual({
      from: at("2026-09-01T00:00:00Z"),
      to: at("2026-10-01T00:00:00Z"),
    });
    /* Later in the month it is still last month, and January reaches back into December. */
    expect(duePeriod("monthly", at("2026-10-28T12:00:00Z"))?.from).toEqual(
      at("2026-09-01T00:00:00Z"),
    );
    expect(duePeriod("monthly", at("2027-01-03T12:00:00Z"))).toEqual({
      from: at("2026-12-01T00:00:00Z"),
      to: at("2027-01-01T00:00:00Z"),
    });
  });

  it("is last week from Monday 08:00 UTC", () => {
    /* 2026-10-05 is a Monday. */
    expect(duePeriod("weekly", at("2026-10-05T07:00:00Z"))).toBeUndefined();
    expect(duePeriod("weekly", at("2026-10-07T12:00:00Z"))).toEqual({
      from: at("2026-09-28T00:00:00Z"),
      to: at("2026-10-05T00:00:00Z"),
    });
  });
});

describe("files", () => {
  it("labels whole-day periods by their last day", () => {
    expect(periodLabel(report.from, report.to)).toBe("2026-09-01 to 2026-09-30 (UTC)");
    expect(periodLabel("2026-09-01T00:00:00Z", "2026-09-10T15:30:00Z")).toBe(
      "2026-09-01 00:00 to 2026-09-10 15:30 UTC",
    );
    expect(slaFileName(report, "pdf")).toBe("sla-report-2026-09-01-to-2026-09-30.pdf");
  });

  it("writes CSV cells that stay cells", () => {
    const [header, row, total] = slaCsv(report).trimEnd().split("\r\n");
    expect(header?.split(",")).toHaveLength(12);
    /* Commas and quotes are quoted; a missing number is an empty cell, not a zero. */
    expect(row).toBe('"Shop, ""main"" site",http,99.9306,1800,0,1,120,1800,97.5,480,,8640');
    expect(total).toBe("All monitors,,99.9306,1800,0,1,120,1800,97.5,480,,8640");
    const risky = { ...report, rows: [{ ...report.rows[0]!, name: "@cmd" }] };
    expect(slaCsv(risky).split("\r\n")[1]).toMatch(/^'@cmd,/);
  });

  it("lays the PDF out from the report, under our name or the customer's", () => {
    const ours = slaPdf(report, null);
    expect(ours.footer).toBe("Watchpost · SLA report · generated 2026-10-01");
    expect(slaPdf(report, "Acme Agency").footer).toBe(
      "Acme Agency · SLA report · generated 2026-10-01",
    );
    const text = JSON.stringify(ours.blocks);
    expect(text).toContain("Group: Shop");
    expect(text).toContain("Period: 2026-09-01 to 2026-09-30 (UTC)");
    /* 1,800 seconds are 30.0 minutes; a missing percentile is a dash. */
    expect(text).toContain('"99.931%","30.0","1","2.0","30.0"');
    expect(text).toContain('"98","480","-"');
    expect(text).toContain("Planned maintenance is left out of both.");
  });
});
