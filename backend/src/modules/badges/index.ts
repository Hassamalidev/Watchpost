/* Public API of the badges module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { RequestHandler } from "express";
import type { AppModule, Infra } from "../../composition/types.js";
import type { DetectionService } from "../detection/index.js";
import type { MonitorsService } from "../monitors/index.js";
import type { ResultsService } from "../results/index.js";
import { createBadgesController } from "./badges.controller.js";
import { createBadgesRouter, createPublicBadgesRouter } from "./badges.routes.js";
import { createBadgesService, type BadgesService } from "./badges.service.js";

export type { BadgeKind, BadgeLinks, BadgesService } from "./badges.service.js";

export interface BadgesModuleDeps {
  infra: Pick<Infra, "clock" | "config">;
  monitors: Pick<MonitorsService, "get" | "getForDetection">;
  detection: Pick<DetectionService, "state" | "uptime">;
  results: Pick<ResultsService, "latencyAverage">;
  guards: { session: RequestHandler; workspace: RequestHandler };
}

export interface BadgesModule extends AppModule {
  service: BadgesService;
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
  return {
    name: "badges",
    service,
    routers: [
      { path: "/api/w/:workspaceId", router: createBadgesRouter(controller, deps.guards) },
      { path: "/api/public/badges", router: createPublicBadgesRouter(controller) },
    ],
  };
}
