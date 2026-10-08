/* Typed calls and hooks for SLA reports and their schedules (PRODUCT.md §6.10, §7.10). */
"use client";

import { useQuery } from "@tanstack/react-query";
import type { ReportScheduleInput, ReportScheduleView, ReportTarget, SlaReport } from "@app/shared";
import { api, wsPath } from "@/lib/api";

export interface ReportQuery {
  target: ReportTarget;
  from: string;
  to: string;
  excludeMaintenance: boolean;
}

/* The first is the default: every plan keeps at least 30 days of history. */
export const PERIODS = ["last30", "last7", "thisMonth", "lastMonth", "last90"] as const;
export type Period = (typeof PERIODS)[number];

const DAY = 86_400_000;

/* A period as UTC instants; `to` is exclusive. Months are calendar months in UTC. */
export function periodRange(period: Period, now: Date): { from: string; to: string } {
  const month = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  if (period === "lastMonth") {
    return {
      from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString(),
      to: new Date(month).toISOString(),
    };
  }
  if (period === "thisMonth") {
    return { from: new Date(month).toISOString(), to: now.toISOString() };
  }
  const days = period === "last7" ? 7 : period === "last30" ? 30 : 90;
  return { from: new Date(now.getTime() - days * DAY).toISOString(), to: now.toISOString() };
}

function search(query: ReportQuery): string {
  const params = new URLSearchParams({
    kind: query.target.kind,
    from: query.from,
    to: query.to,
    excludeMaintenance: String(query.excludeMaintenance),
  });
  if (query.target.id !== undefined) params.set("id", query.target.id);
  return params.toString();
}

/* Where the browser downloads the report as a file. */
export const reportFileHref = (ws: string, extension: "csv" | "pdf", query: ReportQuery) =>
  wsPath(ws, `/reports/sla.${extension}?${search(query)}`);

export const reportKeys = {
  sla: (ws: string, query: ReportQuery) => ["reports", ws, "sla", search(query)] as const,
  schedules: (ws: string) => ["reports", ws, "schedules"] as const,
};

export const reportsApi = {
  sla: (ws: string, query: ReportQuery) =>
    api<SlaReport>(wsPath(ws, `/reports/sla?${search(query)}`)),
  schedules: (ws: string) => api<{ data: ReportScheduleView[] }>(wsPath(ws, "/reports/schedules")),
  createSchedule: (ws: string, body: ReportScheduleInput) =>
    api<ReportScheduleView>(wsPath(ws, "/reports/schedules"), { method: "POST", body }),
  deleteSchedule: (ws: string, id: string) =>
    api<undefined>(wsPath(ws, `/reports/schedules/${id}`), { method: "DELETE" }),
};

export function useSlaReport(ws: string, query: ReportQuery, enabled: boolean) {
  return useQuery({
    queryKey: reportKeys.sla(ws, query),
    queryFn: () => reportsApi.sla(ws, query),
    enabled,
  });
}

export function useReportSchedules(ws: string) {
  return useQuery({
    queryKey: reportKeys.schedules(ws),
    queryFn: async () => (await reportsApi.schedules(ws)).data,
  });
}
