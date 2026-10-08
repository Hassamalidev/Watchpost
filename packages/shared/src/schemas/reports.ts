/*
 * SLA reports (PRODUCT.md §6.10, §9.9): what a report covers, its numbers, and the schedules that
 * email it. The API, the PDF, the CSV and the web app all read these shapes, so they can't disagree.
 */
import { z } from "zod";

export const REPORT_TARGET_KINDS = ["workspace", "monitor", "group", "page"] as const;
export type ReportTargetKind = (typeof REPORT_TARGET_KINDS)[number];

export const REPORT_FREQUENCIES = ["weekly", "monthly"] as const;
export type ReportFrequency = (typeof REPORT_FREQUENCIES)[number];

export const REPORT_MAX_RECIPIENTS = 10;
export const REPORT_MAX_SCHEDULES = 50;
/* A report covers at most this many days and this many monitors. */
export const REPORT_MAX_DAYS = 366;
export const REPORT_MAX_MONITORS = 500;

/* What a report is about: every monitor, one monitor, a monitor group, or a status page's monitors. */
export const reportTargetSchema = z
  .object({
    kind: z.enum(REPORT_TARGET_KINDS),
    id: z.uuid().optional(),
  })
  .refine((t) => (t.kind === "workspace") === (t.id === undefined), {
    path: ["id"],
    message: "needed for a monitor, a group or a status page, and only then",
  });
export type ReportTarget = z.infer<typeof reportTargetSchema>;

/* One monitor's numbers for the period. Times are in seconds as the SLA math produces them. */
export interface SlaReportRow {
  monitorId: string;
  name: string;
  type: string;
  /* Null when the monitor didn't exist during the period. */
  uptimePercent: number | null;
  rangeSeconds: number;
  downtimeSeconds: number;
  maintenanceSeconds: number;
  incidents: number;
  /* Mean seconds until an incident was acknowledged, and until it was resolved. */
  mttaSeconds: number | null;
  mttrSeconds: number | null;
  /* Latency of successful checks in milliseconds; null when there were none. */
  p50: number | null;
  p95: number | null;
  p99: number | null;
  checks: number;
}

export type SlaReportTotals = Omit<SlaReportRow, "monitorId" | "name" | "type">;

export interface SlaReport {
  workspaceName: string;
  target: { kind: ReportTargetKind; id: string | null; name: string };
  from: string;
  to: string;
  excludeMaintenance: boolean;
  generatedAt: string;
  totals: SlaReportTotals;
  rows: SlaReportRow[];
  /* True when the target has more monitors than a report holds; the rest are left out. */
  truncated: boolean;
}

export const reportScheduleInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  target: reportTargetSchema,
  frequency: z.enum(REPORT_FREQUENCIES),
  recipients: z
    .array(z.email().max(254).toLowerCase())
    .min(1)
    .max(REPORT_MAX_RECIPIENTS)
    .transform((list) => [...new Set(list)]),
  excludeMaintenance: z.boolean().default(true),
  /* White-label (Business): the name printed on the PDF instead of ours. */
  brandName: z.string().trim().min(1).max(80).nullable().default(null),
});
export type ReportScheduleInput = z.infer<typeof reportScheduleInputSchema>;

export interface ReportScheduleView {
  id: string;
  name: string;
  target: { kind: ReportTargetKind; id: string | null; name: string };
  frequency: ReportFrequency;
  recipients: string[];
  excludeMaintenance: boolean;
  brandName: string | null;
  /* Start of the last period that was sent, if any. */
  lastPeriodStart: string | null;
  createdAt: string;
}

/* What the weekly digest's AI paragraph is: a short reading of the week, nothing else. */
export const aiDigestInsightSchema = z
  .object({ insight: z.string().trim().min(1).max(700) })
  .strict();
export type AiDigestInsight = z.infer<typeof aiDigestInsightSchema>;
