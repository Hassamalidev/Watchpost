/* TanStack Query hooks for monitors; dashboards poll every 10 s (PRODUCT.md §14 "live feel"). */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { monitorsApi, type CreateMonitorBody } from "./api";

export const monitorKeys = {
  all: (ws: string) => ["monitors", ws] as const,
  one: (ws: string, id: string) => ["monitors", ws, id] as const,
  states: (ws: string) => ["monitor-states", ws] as const,
};

export function useMonitors(ws: string) {
  return useQuery({
    queryKey: monitorKeys.all(ws),
    queryFn: async () => (await monitorsApi.list(ws)).data,
  });
}

export function useMonitorStates(ws: string) {
  return useQuery({
    queryKey: monitorKeys.states(ws),
    queryFn: async () => new Map((await monitorsApi.states(ws)).data.map((s) => [s.monitorId, s])),
    refetchInterval: 10_000,
  });
}

export function useMonitor(ws: string, id: string) {
  return useQuery({ queryKey: monitorKeys.one(ws, id), queryFn: () => monitorsApi.get(ws, id) });
}

export function useCreateMonitor(ws: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateMonitorBody) => monitorsApi.create(ws, body),
    onSuccess: () => client.invalidateQueries({ queryKey: monitorKeys.all(ws) }),
  });
}
