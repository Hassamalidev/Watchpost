/* Typed calls and hooks for incidents; an open incident polls every 3 s (PRODUCT.md §14). */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Explanation } from "@app/shared";
import { api, wsPath } from "@/lib/api";

export type IncidentStatus = "triggered" | "acknowledged" | "snoozed" | "resolved";

export interface Incident {
  id: string;
  number: number;
  source: string;
  monitorId: string | null;
  title: string;
  severity: "critical" | "high" | "low";
  status: IncidentStatus;
  causeCode: string | null;
  failingRegions: string[];
  startedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  falseAlarm: boolean;
  durationSeconds: number;
}

export interface TimelineEntry {
  id: string;
  at: string;
  type: string;
  actor: string;
  data: Record<string, unknown>;
}

export interface IncidentDetail extends Incident {
  timeline: TimelineEntry[];
  comments: Array<{ id: string; authorId: string; body: string; createdAt: string }>;
  monitor: { id: string; name: string; target: string | null; regionCount: number } | null;
  explanation: Explanation | null;
}

export interface IncidentQuery {
  status?: string;
  monitorId?: string;
  severity?: string;
}

export const incidentsApi = {
  list: (ws: string, query: IncidentQuery) => {
    const params = new URLSearchParams({ limit: "100" });
    if (query.status) params.set("status", query.status);
    if (query.monitorId) params.set("monitorId", query.monitorId);
    if (query.severity) params.set("severity", query.severity);
    return api<{ data: Incident[] }>(wsPath(ws, `/incidents?${params.toString()}`));
  },
  get: (ws: string, ref: string) => api<IncidentDetail>(wsPath(ws, `/incidents/${ref}`)),
  act: (ws: string, id: string, action: "acknowledge" | "resolve") =>
    api<Incident>(wsPath(ws, `/incidents/${id}/${action}`), { method: "POST", body: {} }),
  comment: (ws: string, id: string, body: string) =>
    api<unknown>(wsPath(ws, `/incidents/${id}/comments`), { method: "POST", body: { body } }),
  falseAlarm: (ws: string, id: string, falseAlarm: boolean) =>
    api<Incident>(wsPath(ws, `/incidents/${id}/false-alarm`), {
      method: "POST",
      body: { falseAlarm },
    }),
};

export function useIncidents(ws: string, query: IncidentQuery) {
  return useQuery({
    queryKey: ["incidents", ws, query],
    queryFn: async () => (await incidentsApi.list(ws, query)).data,
    refetchInterval: 10_000,
  });
}

export function useIncident(ws: string, ref: string) {
  return useQuery({
    queryKey: ["incident", ws, ref],
    queryFn: () => incidentsApi.get(ws, ref),
    refetchInterval: (query) => (query.state.data?.status === "resolved" ? false : 3_000),
  });
}

export function useIncidentAction(ws: string, ref: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["incident", ws, ref] });
      await client.invalidateQueries({ queryKey: ["incidents", ws] });
    },
  });
}
