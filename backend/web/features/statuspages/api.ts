/* Typed calls and hooks for status pages in the app (PRODUCT.md §7.10). */
"use client";

import { useQuery } from "@tanstack/react-query";
import type {
  CreateStatusIncidentInput,
  PostStatusUpdateInput,
  PublicStatusPage,
  StatusBranding,
  StatusComponentInput,
  StatusIncidentView,
  StatusPageSettings,
  StatusPageView,
} from "@app/shared";
import { api, wsPath } from "@/lib/api";

export const statusPageKeys = {
  all: (ws: string) => ["status-pages", ws] as const,
  one: (ws: string, id: string) => ["status-pages", ws, id] as const,
  preview: (ws: string, id: string) => ["status-pages", ws, id, "preview"] as const,
  incidents: (ws: string, id: string) => ["status-pages", ws, id, "incidents"] as const,
};

export interface CreatePageBody {
  name: string;
  slug: string;
  monitorIds?: string[];
}

export interface UpdatePageBody {
  name?: string;
  slug?: string;
  branding?: StatusBranding;
  settings?: StatusPageSettings;
  published?: boolean;
}

export const statusPagesApi = {
  list: (ws: string) => api<{ data: StatusPageView[] }>(wsPath(ws, "/status-pages")),
  get: (ws: string, id: string) => api<StatusPageView>(wsPath(ws, `/status-pages/${id}`)),
  create: (ws: string, body: CreatePageBody) =>
    api<StatusPageView>(wsPath(ws, "/status-pages"), { method: "POST", body }),
  update: (ws: string, id: string, body: UpdatePageBody) =>
    api<StatusPageView>(wsPath(ws, `/status-pages/${id}`), { method: "PATCH", body }),
  remove: (ws: string, id: string) =>
    api<void>(wsPath(ws, `/status-pages/${id}`), { method: "DELETE" }),
  replaceComponents: (ws: string, id: string, components: StatusComponentInput[]) =>
    api<StatusPageView>(wsPath(ws, `/status-pages/${id}/components`), {
      method: "PUT",
      body: { components },
    }),
  setDomain: (ws: string, id: string, domain: string | null) =>
    api<StatusPageView>(wsPath(ws, `/status-pages/${id}/domain`), {
      method: "PUT",
      body: { domain },
    }),
  verifyDomain: (ws: string, id: string) =>
    api<StatusPageView>(wsPath(ws, `/status-pages/${id}/domain/verify`), {
      method: "POST",
      body: {},
    }),
  preview: (ws: string, id: string) =>
    api<PublicStatusPage>(wsPath(ws, `/status-pages/${id}/preview`)),
  incidents: (ws: string, id: string) =>
    api<{ data: StatusIncidentView[] }>(wsPath(ws, `/status-pages/${id}/incidents`)),
  createIncident: (ws: string, id: string, body: Partial<CreateStatusIncidentInput>) =>
    api<StatusIncidentView>(wsPath(ws, `/status-pages/${id}/incidents`), {
      method: "POST",
      body,
    }),
  publishIncident: (ws: string, id: string, incidentId: string) =>
    api<StatusIncidentView>(wsPath(ws, `/status-pages/${id}/incidents/${incidentId}`), {
      method: "PATCH",
      body: { published: true },
    }),
  postUpdate: (ws: string, id: string, incidentId: string, body: PostStatusUpdateInput) =>
    api<StatusIncidentView>(wsPath(ws, `/status-pages/${id}/incidents/${incidentId}/updates`), {
      method: "POST",
      body,
    }),
  removeIncident: (ws: string, id: string, incidentId: string) =>
    api<void>(wsPath(ws, `/status-pages/${id}/incidents/${incidentId}`), { method: "DELETE" }),
};

export function useStatusPages(ws: string) {
  return useQuery({
    queryKey: statusPageKeys.all(ws),
    queryFn: async () => (await statusPagesApi.list(ws)).data,
  });
}

export function useStatusPage(ws: string, id: string) {
  return useQuery({
    queryKey: statusPageKeys.one(ws, id),
    queryFn: () => statusPagesApi.get(ws, id),
  });
}

/* The preview follows the monitors, so it polls like the dashboards do. */
export function useStatusPreview(ws: string, id: string) {
  return useQuery({
    queryKey: statusPageKeys.preview(ws, id),
    queryFn: () => statusPagesApi.preview(ws, id),
    refetchInterval: 10_000,
  });
}

export function useStatusIncidents(ws: string, id: string) {
  return useQuery({
    queryKey: statusPageKeys.incidents(ws, id),
    queryFn: async () => (await statusPagesApi.incidents(ws, id)).data,
  });
}

/* "Acme Inc." → "acme-inc": a starting point for the page's address. */
export function slugFromName(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      /* Drop the accents NFKD split off, so "ü" becomes "u". */
      .replace(/\p{M}/gu, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63)
      .replace(/-+$/, "")
  );
}
