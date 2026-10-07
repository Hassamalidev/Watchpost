/* Public API of the statuspages module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { RequestHandler } from "express";
import type { AppModule, Infra } from "../../composition/types.js";
import type { PlanFeatures, PlanLimits } from "../../config/plans.js";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import { newId } from "../../infra/ids.js";
import type { DetectionService } from "../detection/index.js";
import type { MaintenanceService } from "../maintenance/index.js";
import type { MonitorsService } from "../monitors/index.js";
import { createStatuspagesProcessors } from "./jobs/index.js";
import { createStatuspagesController } from "./statuspages.controller.js";
import { createStatuspagesRepository } from "./statuspages.repository.js";
import { createPublicStatusRouter, createStatuspagesRouter } from "./statuspages.routes.js";
import { createStatuspagesService, type StatuspagesService } from "./statuspages.service.js";

export { statusPageTag, type PublicRef, type StatuspagesService } from "./statuspages.service.js";

export interface StatuspagesModuleDeps {
  infra: Pick<Infra, "db" | "outbox" | "clock" | "logger" | "config" | "revalidate">;
  monitors: Pick<MonitorsService, "get" | "getForDetection">;
  detection: Pick<DetectionService, "states" | "uptimeDays" | "uptime">;
  maintenance: Pick<MaintenanceService, "list">;
  /* What the workspace's plan allows (from billing, handed in by the composition root). */
  plan: (scope: WorkspaceScope) => Promise<{ limits: PlanLimits; features: PlanFeatures }>;
  guards: { session: RequestHandler; workspace: RequestHandler };
}

export interface StatuspagesModule extends AppModule {
  service: StatuspagesService;
}

export function createStatuspagesModule(deps: StatuspagesModuleDeps): StatuspagesModule {
  const { config } = deps.infra;
  const service = createStatuspagesService({
    db: deps.infra.db,
    repository: createStatuspagesRepository(deps.infra.db),
    monitors: deps.monitors,
    detection: deps.detection,
    maintenance: deps.maintenance,
    plan: deps.plan,
    revalidate: deps.infra.revalidate,
    outbox: deps.infra.outbox,
    clock: deps.infra.clock,
    logger: deps.infra.logger,
    newId,
    webOrigin: config.webOrigin,
    baseDomain: config.statusPages.baseDomain,
  });
  const controller = createStatuspagesController(service);
  return {
    name: "statuspages",
    service,
    routers: [
      { path: "/api/w/:workspaceId", router: createStatuspagesRouter(controller, deps.guards) },
      { path: "/api/public/status", router: createPublicStatusRouter(controller) },
    ],
    processors: createStatuspagesProcessors(service, deps.infra.db),
  };
}
