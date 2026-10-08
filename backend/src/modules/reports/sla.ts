/*
 * SLA reports as files (PRODUCT.md §6.10): the periods schedules cover, and one report laid out as
 * CSV and as PDF blocks. Pure: every number comes from the report it is given, so the screen, the
 * CSV and the PDF can't disagree.
 */
import type { ReportFrequency, SlaReport, SlaReportRow, SlaReportTotals } from "@app/shared";
import type { PdfBlock } from "../../infra/pdf.js";

const DAY = 86_400_000;
/* Reports go out from 08:00 UTC on the first day after the period. */
export const SEND_FROM_HOUR_UTC = 8;

/* Monday 00:00 UTC of the week containing `at`. */
export function weekStartOf(at: Date): Date {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - sinceMonday * DAY);
}

/* The first day of the month containing `at`, 00:00 UTC. */
export function monthStartOf(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

/*
 * The last complete week or month, once its report may be sent (08:00 UTC on the day after it
 * ended); undefined earlier than that on that day.
 */
export function duePeriod(
  frequency: ReportFrequency,
  now: Date,
): { from: Date; to: Date } | undefined {
  const to = frequency === "weekly" ? weekStartOf(now) : monthStartOf(now);
  if (now.getTime() < to.getTime() + SEND_FROM_HOUR_UTC * 3_600_000) return undefined;
  const from =
    frequency === "weekly"
      ? new Date(to.getTime() - 7 * DAY)
      : new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - 1, 1));
  return { from, to };
}

const day = (iso: string | Date) => new Date(iso).toISOString().slice(0, 10);

/* "2026-09-01 to 2026-09-30 (UTC)": the last day is the one before the exclusive end. */
export function periodLabel(from: string | Date, to: string | Date): string {
  const end = new Date(to);
  const wholeDays = end.getTime() % DAY === 0 && new Date(from).getTime() % DAY === 0;
  const last = wholeDays ? new Date(end.getTime() - DAY) : end;
  return wholeDays
    ? `${day(from)} to ${day(last)} (UTC)`
    : `${new Date(from).toISOString().slice(0, 16).replace("T", " ")} to ${end.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export const percentText = (value: number | null) =>
  value === null ? "-" : `${value.toFixed(3)}%`;
/* Minutes with one decimal, from the seconds the SLA math produces. */
export const minutesText = (seconds: number | null) =>
  seconds === null ? "-" : (seconds / 60).toFixed(1);
const msText = (value: number | null) => (value === null ? "-" : String(Math.round(value)));

/*
 * A CSV cell. A spreadsheet runs a cell that starts with =, +, - or @ as a formula, and monitor
 * names come from users, so such text is prefixed with a quote that makes it plain text.
 */
function cell(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const CSV_HEADER = [
  "Monitor",
  "Type",
  "Uptime %",
  "Downtime seconds",
  "Maintenance seconds",
  "Incidents",
  "MTTA seconds",
  "MTTR seconds",
  "p50 ms",
  "p95 ms",
  "p99 ms",
  "Checks",
];

const csvNumbers = (r: SlaReportTotals) => [
  r.uptimePercent,
  r.downtimeSeconds,
  r.maintenanceSeconds,
  r.incidents,
  r.mttaSeconds,
  r.mttrSeconds,
  r.p50,
  r.p95,
  r.p99,
  r.checks,
];

/* One line per monitor and a last line for all of them; numbers exactly as the report holds them. */
export function slaCsv(report: SlaReport): string {
  const lines = [
    CSV_HEADER,
    ...report.rows.map((r: SlaReportRow) => [r.name, r.type, ...csvNumbers(r)]),
    ["All monitors", "", ...csvNumbers(report.totals)],
  ];
  return `${lines.map((line) => line.map(cell).join(",")).join("\r\n")}\r\n`;
}

export function slaFileName(report: SlaReport, extension: "csv" | "pdf"): string {
  return `sla-report-${day(report.from)}-to-${day(new Date(new Date(report.to).getTime() - 1))}.${extension}`;
}

const TARGET_LABEL = {
  workspace: "All monitors",
  monitor: "Monitor",
  group: "Group",
  page: "Status page",
} as const;

/* The report as a document. `brand` replaces our name on white-label reports. */
export function slaPdf(
  report: SlaReport,
  brand: string | null,
): { title: string; footer: string; blocks: PdfBlock[] } {
  const t = report.totals;
  const subject =
    report.target.kind === "workspace"
      ? report.workspaceName
      : `${TARGET_LABEL[report.target.kind]}: ${report.target.name}`;
  const blocks: PdfBlock[] = [
    { kind: "heading", level: 1, text: "SLA report" },
    { kind: "paragraph", text: subject },
    { kind: "paragraph", text: `Period: ${periodLabel(report.from, report.to)}` },
    { kind: "heading", level: 2, text: "Summary" },
    {
      kind: "table",
      header: ["Uptime", "Downtime (min)", "Incidents", "MTTA (min)", "MTTR (min)"],
      rows: [
        [
          percentText(t.uptimePercent),
          minutesText(t.downtimeSeconds),
          String(t.incidents),
          minutesText(t.mttaSeconds),
          minutesText(t.mttrSeconds),
        ],
      ],
    },
    {
      kind: "table",
      header: ["Latency p50 (ms)", "p95 (ms)", "p99 (ms)", "Checks", "Maintenance (min)"],
      rows: [
        [
          msText(t.p50),
          msText(t.p95),
          msText(t.p99),
          String(t.checks),
          minutesText(t.maintenanceSeconds),
        ],
      ],
    },
    { kind: "heading", level: 2, text: "Monitors" },
    report.rows.length === 0
      ? { kind: "paragraph", text: "There are no monitors in this report." }
      : {
          kind: "table",
          widths: [4, 2, 2, 2, 2, 2, 1.5, 1.5, 1.5],
          header: [
            "Monitor",
            "Uptime",
            "Down (min)",
            "Incidents",
            "MTTA",
            "MTTR",
            "p50",
            "p95",
            "p99",
          ],
          rows: report.rows.map((r) => [
            r.name,
            percentText(r.uptimePercent),
            minutesText(r.downtimeSeconds),
            String(r.incidents),
            minutesText(r.mttaSeconds),
            minutesText(r.mttrSeconds),
            msText(r.p50),
            msText(r.p95),
            msText(r.p99),
          ]),
        },
    { kind: "space" },
    {
      kind: "paragraph",
      text: [
        "Uptime is one minus downtime divided by the time in the period, from recorded outages, not from sampled checks.",
        report.excludeMaintenance
          ? "Planned maintenance is left out of both."
          : "Planned maintenance counts as downtime.",
        "MTTA and MTTR are the mean minutes until an incident was acknowledged and resolved.",
        "Latency is of successful checks, in milliseconds. A dash means there is nothing to report.",
        report.truncated ? "Only the first monitors are listed; the report holds no more." : "",
      ]
        .filter((line) => line !== "")
        .join(" "),
    },
  ];
  return {
    title: `SLA report ${day(report.from)}`,
    footer: `${brand ?? "Watchpost"} · SLA report · generated ${day(report.generatedAt)}`,
    blocks,
  };
}
