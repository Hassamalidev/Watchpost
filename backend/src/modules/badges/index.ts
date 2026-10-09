/* Public API of the badges module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { RequestHandler } from "express";
import type { AppModule, Infra } from "../../composition/types.js";
import type { DetectionService } from "../detection/index.js";
import type { MonitorsService } from "../monitors/index.js";
import type { ResultsService, RollupsService } from "../results/index.js";
import type { StatuspagesService } from "../statuspages/index.js";
import {
  createEmbedsService,
  createStatusWidgetRouter,
  embedsPublicRoutes,
  type EmbedsService,
} from "./embeds.js";
import { createBadgesController } from "./badges.controller.js";
import { createBadgesRouter, createPublicBadgesRouter } from "./badges.routes.js";
import { createBadgesService, type BadgesService } from "./badges.service.js";

export type { BadgeKind, BadgeLinks, BadgesService } from "./badges.service.js";

export interface BadgesModuleDeps {
  infra: Pick<Infra, "clock" | "config">;
  monitors: Pick<MonitorsService, "get" | "getForDetection" | "list">;
  detection: Pick<DetectionService, "state" | "uptime" | "states" | "uptimeMany">;
  results: Pick<ResultsService, "latencyAverage">;
  latency: Pick<RollupsService, "latencyBetween">;
  statuspages: Pick<StatuspagesService, "publicPage">;
  guards: { session: RequestHandler; workspace: RequestHandler };
}

export interface BadgesModule extends AppModule {
  service: BadgesService;
  embeds: EmbedsService;
}

export function createBadgesModule(deps: BadgesModuleDeps): BadgesModule {
  const service = createBadgesService({
    monitors: deps.monitors,
    detection: deps.detection,
    results: deps.results,
    clock: deps.infra.clock,
    secret: deps.infra.config.auth.secret,
    webOrigin: deps.infra.config.webOrigin,
  });
  const controller = createBadgesController(service);
  const embeds = createEmbedsService({
    monitors: deps.monitors,
    detection: deps.detection,
    latency: deps.latency,
    statuspages: deps.statuspages,
    clock: deps.infra.clock,
  });
  return {
    name: "badges",
    service,
    embeds,
    routers: [
      { path: "/api/w/:workspaceId", router: createBadgesRouter(controller, deps.guards) },
      { path: "/api/public/badges", router: createPublicBadgesRouter(controller) },
      { path: "/api/public/status-widget", router: createStatusWidgetRouter(embeds) },
    ],
    publicRoutes: embedsPublicRoutes(embeds),
  };
}
