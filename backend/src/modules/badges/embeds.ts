/*
 * Two more things other tools embed (PRODUCT.md §6.13), next to the monitor badges:
 *
 * - `GET /api/v1/metrics`: the workspace's monitors in the Prometheus text format, behind an API key
 *   with `monitors:read`. One scrape reads every monitor's status, 24-hour and 30-day uptime and
 *   response times, with the same uptime calculation as everywhere else.
 * - `GET /api/public/status-widget/<slug>.svg`: a status page's overall state as a small image for
 *   a website's footer ("status | all systems operational"), public like the page itself and cached
 *   for a minute.
 */
import { Router } from "express";
import { z } from "zod";
import type { OverallStatus } from "@app/shared";
import type { Clock } from "../../core/clock.js";
import { publicRoute, type PublicRoute } from "../../core/public-api.js";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import { inputOf, validate } from "../../middleware/validate.js";
import type { DetectionService } from "../detection/index.js";
import type { MonitorsService } from "../monitors/index.js";
import type { RollupsService } from "../results/index.js";
import type { StatuspagesService } from "../statuspages/index.js";
import { prometheusText, type MonitorMetrics } from "./metrics.js";
import { renderBadge, type Badge } from "./render.js";

const DAY_MS = 86_400_000;
const PAGE = 200;
/* A scrape reads at most this many monitors; larger workspaces get the first ones by ID. */
export const METRICS_MAX_MONITORS = 2_000;
const WIDGET_CACHE_SECONDS = 60;

const WIDGET: Record<OverallStatus, Pick<Badge, "message" | "color">> = {
  operational: { message: "all systems operational", color: "green" },
  degraded: { message: "degraded performance", color: "amber" },
  partial_outage: { message: "partial outage", color: "red" },
  major_outage: { message: "major outage", color: "red" },
  maintenance: { message: "under maintenance", color: "blue" },
};

export interface EmbedsService {
  /* The workspace's monitors as Prometheus text. */
  metrics(scope: WorkspaceScope): Promise<string>;
  /* Public: the widget for a published status page, or undefined when there is no such page. */
  statusWidget(slug: string): Promise<string | undefined>;
}

export function createEmbedsService(deps: {
  monitors: Pick<MonitorsService, "list">;
  detection: Pick<DetectionService, "states" | "uptimeMany">;
  latency: Pick<RollupsService, "latencyBetween">;
  statuspages: Pick<StatuspagesService, "publicPage">;
  clock: Clock;
}): EmbedsService {
  const widgets = new Map<string, { svg: string | undefined; expiresAt: number }>();

  return {
    async metrics(scope) {
      const monitors = [];
      let cursor: string | undefined;
      do {
        const page = await deps.monitors.list(scope, {
          limit: PAGE,
          ...(cursor === undefined ? {} : { cursor }),
        });
        monitors.push(...page.data);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined && monitors.length < METRICS_MAX_MONITORS);
      const now = deps.clock.now();
      const day = new Date(now.getTime() - DAY_MS);
      const ids = monitors.map((m) => m.id);
      const [states, uptime24h, uptime30d, latency] = await Promise.all([
        deps.detection.states(scope),
        deps.detection.uptimeMany(scope, monitors, {
          from: day,
          to: now,
          excludeMaintenance: true,
        }),
        deps.detection.uptimeMany(scope, monitors, {
          from: new Date(now.getTime() - 30 * DAY_MS),
          to: now,
          excludeMaintenance: true,
        }),
        deps.latency.latencyBetween(scope, ids, day, now),
      ]);
      const statusOf = new Map(states.map((s) => [s.monitorId, s.status]));
      const rows: MonitorMetrics[] = monitors.map((m) => {
        const l = latency.byMonitor.get(m.id);
        return {
          id: m.id,
          name: m.name,
          type: m.type,
          paused: m.paused,
          status: statusOf.get(m.id),
          uptime24h: uptime24h.get(m.id)?.uptimePercent ?? null,
          uptime30d: uptime30d.get(m.id)?.uptimePercent ?? null,
          p50Ms: l?.p50 ?? null,
          p95Ms: l?.p95 ?? null,
          checks24h: l?.checks ?? 0,
        };
      });
      return prometheusText(rows);
    },

    async statusWidget(slug) {
      const now = deps.clock.now().getTime();
      const cached = widgets.get(slug);
      if (cached !== undefined && cached.expiresAt > now) return cached.svg;
      const page = await deps.statuspages.publicPage({ slug });
      const svg =
        page === undefined ? undefined : renderBadge({ label: "status", ...WIDGET[page.status] });
      /* Unknown slugs are remembered too, so guessing names costs us one lookup a minute each. */
      if (widgets.size >= 5_000) widgets.clear();
      widgets.set(slug, { svg, expiresAt: now + WIDGET_CACHE_SECONDS * 1_000 });
      return svg;
    },
  };
}

export function embedsPublicRoutes(service: EmbedsService): PublicRoute[] {
  return [
    publicRoute({
      method: "get",
      path: "/metrics",
      scope: "monitors:read",
      tag: "Metrics",
      summary: "Monitors in the Prometheus text format",
      description:
        "Point a Prometheus scrape job at this address with the key as a bearer token. Each monitor has its status, 24-hour and 30-day uptime and response times. Scrape once a minute or slower: values change when checks run.",
      status: 200,
      text: {
        contentType: "text/plain; version=0.0.4; charset=utf-8",
        description: "Prometheus text exposition format, version 0.0.4.",
      },
      handle: ({ scope }) => service.metrics(scope) as Promise<never>,
    }),
  ];
}

const widgetParams = z.object({
  file: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}\.svg$/, "unknown widget")
    .transform((file) => file.slice(0, -4)),
});

const NOT_FOUND = renderBadge({ label: "status", message: "page not found", color: "gray" });

/* /api/public/status-widget/<slug>.svg: the public zone (§7.1), read-only and cached. */
export function createStatusWidgetRouter(service: EmbedsService): Router {
  const router = Router();
  router.get("/:file", validate({ params: widgetParams }), async (req, res) => {
    const { params } = inputOf<{ params: typeof widgetParams }>(req, res);
    const svg = await service.statusWidget(params.file);
    res
      .status(svg === undefined ? 404 : 200)
      .set(
        "cache-control",
        svg === undefined
          ? "no-store"
          : `public, max-age=${WIDGET_CACHE_SECONDS}, s-maxage=${WIDGET_CACHE_SECONDS}`,
      )
      /* An image only: nothing in it may run, wherever it is embedded. */
      .set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
      .set("x-content-type-options", "nosniff")
      .set("cross-origin-resource-policy", "cross-origin")
      .type("image/svg+xml")
      .send(svg ?? NOT_FOUND);
  });
  return router;
}
