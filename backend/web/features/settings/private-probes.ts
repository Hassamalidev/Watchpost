/* Private probes: typed calls, and the name to show for a check location (PRODUCT.md §7.10). */
"use client";

import { useQuery } from "@tanstack/react-query";
import type { CreatedPrivateProbe, PrivateProbeView } from "@app/shared";
import { api, wsPath } from "@/lib/api";

export const privateProbesKey = (ws: string) => ["private-probes", ws] as const;

export const privateProbesApi = {
  list: (ws: string) => api<{ data: PrivateProbeView[] }>(wsPath(ws, "/private-probes")),
  create: (ws: string, name: string) =>
    api<CreatedPrivateProbe>(wsPath(ws, "/private-probes"), { method: "POST", body: { name } }),
  remove: (ws: string, id: string) =>
    api<undefined>(wsPath(ws, `/private-probes/${id}`), { method: "DELETE" }),
};

export function usePrivateProbes(ws: string) {
  return useQuery({
    queryKey: privateProbesKey(ws),
    queryFn: async () => (await privateProbesApi.list(ws)).data,
    refetchInterval: 30_000,
  });
}

/* A region as people should read it: our regions as they are, a private location by its probe's name. */
export function useRegionLabel(ws: string): (region: string) => string {
  const probes = usePrivateProbes(ws);
  return (region) => probes.data?.find((probe) => probe.region === region)?.name ?? region;
}
