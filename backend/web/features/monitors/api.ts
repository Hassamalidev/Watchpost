/* Typed calls for monitors, their status, charts and expiry (PRODUCT.md §7.10). */
import type { MonitorConfigInput, MonitorStatus, MonitorType } from "@app/shared";
import { api, wsPath } from "@/lib/api";

export interface Monitor {
  id: string;
  type: MonitorType;
  name: string;
  config: Record<string, unknown> & { type: MonitorType };
  intervalSeconds: number;
  regions: string[];
  severity: "critical" | "high" | "low";
  sloTarget: number;
  minFailingRegions: number;
  alertOnRegionalIssue: boolean;
  /* The group it belongs to and the monitor it depends on, when set. */
  groupId?: string | null;
  parentId?: string | null;
  paused: boolean;
  createdAt: string;
}

/* Signed image URLs of a monitor's badges, and where a badge should link to. */
export interface BadgeLinks {
  status: string;
  uptime: string;
  latency: string;
  link: string;
}

export interface MonitorGroup {
  id: string;
  name: string;
  /* Failures in the group within 15 seconds of each other go out as one message. */
  groupAlerts: boolean;
}

export interface MonitorState {
  monitorId: string;
  status: MonitorStatus;
  since: string;
  reason: string | null;
  lastResultAt: string | null;
}

export interface LatencyPoint {
  bucket: string;
  count: number;
  failCount: number;
  avgMs: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface UptimeDay {
  date: string;
  uptimePercent: number | null;
  downtimeSeconds: number;
  status: "up" | "minor" | "major" | "none";
}

export interface Check {
  id: string;
  checkedAt: string;
  region: string;
  ok: boolean;
  errorCode: string | null;
  httpStatus: number | null;
  latencyMs: number;
  message: string | null;
}

export interface Expiry {
  kind: "ssl" | "domain";
  status: "pending" | "ok" | "warning" | "expired" | "unsupported" | "error";
  expiresAt: string | null;
  daysRemaining: number | null;
  message: string | null;
}

export interface ProbeTaskView {
  id: string;
  region: string;
  status: "pending" | "running" | "completed" | "expired";
  result: { ok?: boolean; latencyMs?: number; errorCode?: string } | null;
}

export interface CreateMonitorBody {
  settings: {
    name: string;
    intervalSeconds?: number;
    regions?: string[];
    severity?: "critical" | "high" | "low";
    sloTarget?: number;
    minFailingRegions?: number;
    alertOnRegionalIssue?: boolean;
    groupId?: string;
    parentId?: string;
  };
  config: MonitorConfigInput;
}

export const monitorsApi = {
  list: (ws: string) => api<{ data: Monitor[] }>(wsPath(ws, "/monitors?limit=200")),
  get: (ws: string, id: string) => api<Monitor>(wsPath(ws, `/monitors/${id}`)),
  create: (ws: string, body: CreateMonitorBody) =>
    api<Monitor>(wsPath(ws, "/monitors"), { method: "POST", body }),
  update: (ws: string, id: string, body: { settings?: object; config?: object }) =>
    api<Monitor>(wsPath(ws, `/monitors/${id}`), { method: "PATCH", body }),
  setPaused: (ws: string, id: string, paused: boolean) =>
    api<Monitor>(wsPath(ws, `/monitors/${id}/${paused ? "pause" : "resume"}`), {
      method: "POST",
      body: {},
    }),
  remove: (ws: string, id: string) =>
    api<void>(wsPath(ws, `/monitors/${id}`), { method: "DELETE" }),
  checkRegions: (ws: string) =>
    api<{ data: Array<{ region: string; healthy: boolean }> }>(wsPath(ws, "/check-regions")),
  badges: (ws: string, id: string) => api<BadgeLinks>(wsPath(ws, `/monitors/${id}/badges`)),
  groups: (ws: string) => api<{ data: MonitorGroup[] }>(wsPath(ws, "/monitor-groups")),
  createGroup: (ws: string, body: { name: string; groupAlerts: boolean }) =>
    api<MonitorGroup>(wsPath(ws, "/monitor-groups"), { method: "POST", body }),
  updateGroup: (ws: string, id: string, body: { name: string; groupAlerts: boolean }) =>
    api<MonitorGroup>(wsPath(ws, `/monitor-groups/${id}`), { method: "PATCH", body }),
  states: (ws: string) =>
    api<{ data: MonitorState[]; reducedRegions?: string[] }>(wsPath(ws, "/monitor-states")),
  latency: (ws: string, id: string, range = "24h") =>
    api<{ points: LatencyPoint[]; summary: Omit<LatencyPoint, "bucket"> }>(
      wsPath(ws, `/monitors/${id}/latency?range=${range}`),
    ),
  checks: (ws: string, id: string) =>
    api<{ data: Check[] }>(wsPath(ws, `/monitors/${id}/checks?limit=20`)),
  uptime: (ws: string, id: string) =>
    api<{ uptimePercent: number | null; downtimeSeconds: number }>(
      wsPath(ws, `/monitors/${id}/uptime`),
    ),
  uptimeDays: (ws: string, id: string) =>
    api<{ data: UptimeDay[] }>(wsPath(ws, `/monitors/${id}/uptime/days?days=90`)),
  expiry: (ws: string, id: string) => api<Expiry>(wsPath(ws, `/expiry/${id}`)),
  testNow: (ws: string, id: string) =>
    api<{ data: ProbeTaskView[] }>(wsPath(ws, `/monitors/${id}/test`), {
      method: "POST",
      body: {},
    }),
  task: (ws: string, taskId: string) => api<ProbeTaskView>(wsPath(ws, `/probe-tasks/${taskId}`)),
};

/* Hostname or URL a monitor points at, for lists. */
export function targetOf(monitor: Pick<Monitor, "config">): string {
  /* A multi-step check: where its first step goes, and how many steps there are. */
  const steps = monitor.config.steps;
  if (Array.isArray(steps) && steps.length > 0) {
    const first = (steps[0] as { url?: unknown }).url;
    const origin = /^https?:\/\/[^/?#]+/i.exec(typeof first === "string" ? first : "")?.[0];
    return `${origin ?? ""} (${steps.length})`.trim();
  }
  const c = monitor.config;
  for (const key of ["url", "host", "hostname", "domain"] as const) {
    const value = c[key];
    if (typeof value === "string") return value;
  }
  return "";
}
