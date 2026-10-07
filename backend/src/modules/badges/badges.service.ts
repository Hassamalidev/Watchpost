/*
 * Badges (PRODUCT.md §4 pillar 10, §6.14): small SVG images of a monitor's status, uptime and
 * response time for READMEs and dashboards. A badge URL carries the monitor's ID and a signature, so
 * only someone who was given the URL by a workspace member can read it; nothing is stored. Answers
 * are kept in memory for a minute: a badge on a busy README costs one database read per minute.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { MonitorStatus } from "@app/shared";
import type { Clock } from "../../core/clock.js";
import { NotFoundError } from "../../core/errors.js";
import { createWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import type { DetectionService } from "../detection/index.js";
import type { MonitorsService } from "../monitors/index.js";
import type { ResultsService } from "../results/index.js";
import { renderBadge, type Badge } from "./render.js";

export const BADGE_KINDS = ["status", "uptime", "latency"] as const;
export type BadgeKind = (typeof BADGE_KINDS)[number];
export const BADGE_UPTIME_DAYS = [7, 30, 90] as const;
export type BadgeUptimeDays = (typeof BADGE_UPTIME_DAYS)[number];

export const BADGE_CACHE_SECONDS = 60;
const CACHE_MAX_ENTRIES = 5_000;
const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface BadgeOptions {
  /* Replaces the label on the left ("status", "uptime", "response"). */
  label?: string | undefined;
  /* The period of an uptime badge. */
  days?: BadgeUptimeDays | undefined;
}

export interface BadgeLinks {
  /* Image URLs, one per kind. */
  status: string;
  uptime: string;
  latency: string;
  /* Where a badge should link to when it is clicked. */
  link: string;
}

export interface BadgesService {
  /* The badge URLs of a monitor, for people who may see the monitor. */
  links(scope: WorkspaceScope, monitorId: string): Promise<BadgeLinks>;
  /* Public: the SVG for a badge URL; undefined when the URL is not one of ours. */
  render(token: string, kind: BadgeKind, options?: BadgeOptions): Promise<string | undefined>;
}

export interface BadgesServiceDeps {
  monitors: Pick<MonitorsService, "get" | "getForDetection">;
  detection: Pick<DetectionService, "state" | "uptime">;
  results: Pick<ResultsService, "latencyAverage">;
  clock: Clock;
  /* Signs badge URLs; the app's auth secret. */
  secret: string;
  /* Public base of the API as browsers reach it, and of the site badges link back to. */
  webOrigin: string;
}

const STATUS_BADGE: Record<MonitorStatus, Pick<Badge, "message" | "color">> = {
  up: { message: "up", color: "green" },
  /* A check is being confirmed from other regions; nothing is wrong yet. */
  verifying: { message: "up", color: "green" },
  degraded: { message: "degraded", color: "amber" },
  down: { message: "down", color: "red" },
  maintenance: { message: "maintenance", color: "blue" },
  paused: { message: "paused", color: "gray" },
  pending: { message: "pending", color: "gray" },
};

/* "99.98%" for most values; whole numbers and a perfect score stay short. */
export function formatUptime(percent: number): string {
  if (percent >= 100) return "100%";
  return `${percent
    .toFixed(percent >= 99.9 ? 3 : 2)
    .replace(/0+$/, "")
    .replace(/\.$/, "")}%`;
}

export function uptimeColor(percent: number): Badge["color"] {
  return percent >= 99.9 ? "green" : percent >= 99 ? "amber" : "red";
}

export function formatLatency(ms: number): string {
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(ms >= 10_000 ? 0 : 1)} s` : `${Math.round(ms)} ms`;
}

export function createBadgesService(deps: BadgesServiceDeps): BadgesService {
  const { clock } = deps;
  const key = createHmac("sha256", deps.secret).update("badge-url").digest();
  const signatureOf = (monitorId: string) =>
    createHmac("sha256", key).update(monitorId).digest("base64url").slice(0, 22);
  const tokenOf = (monitorId: string) => `${monitorId}.${signatureOf(monitorId)}`;

  /* The monitor a badge URL names, when its signature is ours. */
  function monitorOf(token: string): string | undefined {
    const [id, signature, extra] = token.split(".");
    if (id === undefined || signature === undefined || extra !== undefined) return undefined;
    const monitorId = id.toLowerCase();
    if (!UUID.test(monitorId)) return undefined;
    const given = Buffer.from(signature);
    const expected = Buffer.from(signatureOf(monitorId));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    return monitorId;
  }

  const cache = new Map<string, { svg: string; expiresAt: number }>();
  function remember(cacheKey: string, svg: string) {
    /* Oldest out first; a Map keeps insertion order. */
    if (cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(cacheKey, { svg, expiresAt: clock.now().getTime() + BADGE_CACHE_SECONDS * 1_000 });
  }

  async function build(monitorId: string, kind: BadgeKind, options: BadgeOptions): Promise<Badge> {
    const [monitor] = await deps.monitors.getForDetection([monitorId]);
    if (monitor === undefined) {
      return { label: options.label ?? kind, message: "not found", color: "gray" };
    }
    const now = clock.now();
    if (kind === "status") {
      const state = monitor.paused
        ? "paused"
        : ((await deps.detection.state(monitorId))?.status ?? "pending");
      return { label: options.label ?? "status", ...STATUS_BADGE[state] };
    }
    if (kind === "uptime") {
      const days = options.days ?? 30;
      const summary = await deps.detection.uptime(
        createWorkspaceScope({ workspaceId: monitor.workspaceId }),
        monitorId,
        { from: new Date(now.getTime() - days * DAY_MS), to: now, excludeMaintenance: true },
      );
      const label = options.label ?? `uptime ${days}d`;
      return summary.uptimePercent === null
        ? { label, message: "no data", color: "gray" }
        : {
            label,
            message: formatUptime(summary.uptimePercent),
            color: uptimeColor(summary.uptimePercent),
          };
    }
    const { averageMs } = await deps.results.latencyAverage(
      monitorId,
      new Date(now.getTime() - DAY_MS),
      now,
    );
    const label = options.label ?? "response";
    return averageMs === null
      ? { label, message: "no data", color: "gray" }
      : { label, message: formatLatency(averageMs), color: "blue" };
  }

  return {
    async links(scope, monitorId) {
      /* Throws NotFound for a monitor of another workspace. */
      const monitor = await deps.monitors.get(scope, monitorId);
      if (monitor === undefined) throw new NotFoundError("Monitor not found.");
      const base = `${deps.webOrigin}/api/public/badges/${tokenOf(monitor.id)}`;
      return {
        status: `${base}/status.svg`,
        uptime: `${base}/uptime.svg`,
        latency: `${base}/latency.svg`,
        link: deps.webOrigin,
      };
    },

    async render(token, kind, options = {}) {
      const monitorId = monitorOf(token);
      if (monitorId === undefined) return undefined;
      const cacheKey = `${monitorId}:${kind}:${options.days ?? ""}:${options.label ?? ""}`;
      const cached = cache.get(cacheKey);
      if (cached !== undefined && cached.expiresAt > clock.now().getTime()) return cached.svg;
      const svg = renderBadge(await build(monitorId, kind, options));
      remember(cacheKey, svg);
      return svg;
    },
  };
}
