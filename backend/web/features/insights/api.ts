/*
 * Typed calls for the insight features (D-047): alert accuracy, error budgets, what changed before an
 * incident, who was notified, and alert drills.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import type { Explanation } from "@app/shared";
import { api, wsPath } from "@/lib/api";

export type { Explanation };

export interface IncidentSummary {
  days: number;
  incidents: number;
  resolved: number;
  falseAlarms: number;
  accuracyPercent: number | null;
  mttaMinutes: number | null;
  mttrMinutes: number | null;
}

export type BudgetStatus = "healthy" | "at_risk" | "exhausted";

export interface ErrorBudget {
  target: number;
  periodStart: string;
  periodEnd: string;
  budgetSeconds: number;
  usedSeconds: number;
  remainingSeconds: number;
  burnRate: number;
  status: BudgetStatus;
}

export interface MonitorBudget extends ErrorBudget {
  monitorId: string;
  name: string;
}

export interface ChangeEvent {
  at: string;
  kind: "deploy" | "address" | "certificate" | "config" | "latency";
  title: string;
  detail: string | null;
  regions: string[];
}

export interface DeliveryLogEntry {
  id: string;
  kind: "triggered" | "acknowledged" | "resolved" | "reminder" | "flapping";
  channelId: string | null;
  channelName: string | null;
  channelType: string | null;
  status: "pending" | "sending" | "retrying" | "sent" | "failed" | "skipped";
  attempts: number;
  error: string | null;
  sentAt: string | null;
  createdAt: string;
}

export const insightsApi = {
  summary: (ws: string, days = 30) =>
    api<IncidentSummary>(wsPath(ws, `/incidents/summary?days=${days}`)),
  budgets: (ws: string) => api<{ data: MonitorBudget[] }>(wsPath(ws, "/error-budgets")),
  budget: (ws: string, monitorId: string) =>
    api<ErrorBudget>(wsPath(ws, `/monitors/${monitorId}/error-budget`)),
  changes: (ws: string, monitorId: string, before?: string) => {
    const params = new URLSearchParams({ hours: "24" });
    if (before) params.set("before", before);
    return api<{ data: ChangeEvent[] }>(
      wsPath(ws, `/monitors/${monitorId}/changes?${params.toString()}`),
    );
  },
  deliveries: (ws: string, incidentId: string) =>
    api<{ data: DeliveryLogEntry[] }>(wsPath(ws, `/incidents/${incidentId}/deliveries`)),
  drill: (ws: string) =>
    api<{ id: string; number: number }>(wsPath(ws, "/incidents/drill"), {
      method: "POST",
      body: {},
    }),
};

export function useSummary(ws: string) {
  return useQuery({
    queryKey: ["incident-summary", ws],
    queryFn: () => insightsApi.summary(ws),
    refetchInterval: 60_000,
  });
}

export function useBudgets(ws: string) {
  return useQuery({
    queryKey: ["error-budgets", ws],
    queryFn: async () => (await insightsApi.budgets(ws)).data,
    refetchInterval: 60_000,
  });
}

export function useBudget(ws: string, monitorId: string) {
  return useQuery({
    queryKey: ["error-budget", ws, monitorId],
    queryFn: () => insightsApi.budget(ws, monitorId),
    refetchInterval: 60_000,
  });
}

export function useChanges(ws: string, monitorId: string, before?: string) {
  return useQuery({
    queryKey: ["changes", ws, monitorId, before ?? "now"],
    queryFn: async () => (await insightsApi.changes(ws, monitorId, before)).data,
  });
}

export function useDeliveries(ws: string, incidentId: string, live: boolean) {
  return useQuery({
    queryKey: ["deliveries", ws, incidentId],
    queryFn: async () => (await insightsApi.deliveries(ws, incidentId)).data,
    refetchInterval: live ? 5_000 : false,
  });
}
