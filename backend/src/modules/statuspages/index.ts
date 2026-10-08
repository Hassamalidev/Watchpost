/* Public API of the statuspages module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { RequestHandler } from "express";
import type { AppModule, Infra } from "../../composition/types.js";
import type { PlanFeatures, PlanLimits } from "../../config/plans.js";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import { newId } from "../../infra/ids.js";
import type { AiService } from "../ai/index.js";
import type { DetectionService } from "../detection/index.js";
import type { MaintenanceService } from "../maintenance/index.js";
import type { MonitorsService } from "../monitors/index.js";
import { createStatuspagesProcessors } from "./jobs/index.js";
import { createStatuspagesController } from "./statuspages.controller.js";
import { createStatuspagesRepository } from "./statuspages.repository.js";
import {
  createInternalTlsRouter,
  createPublicStatusRouter,
  createStatuspagesRouter,
  createSubscriptionLinksRouter,
} from "./statuspages.routes.js";
import { createStatuspagesService, type StatuspagesService } from "./statuspages.service.js";

export { statusPageTag, type PublicRef, type StatuspagesService } from "./statuspages.service.js";

export interface StatuspagesModuleDeps {
  infra: Pick<Infra, "db" | "outbox" | "clock" | "logger" | "config" | "revalidate" | "dns">;
  monitors: Pick<MonitorsService, "get" | "getForDetection">;
  detection: Pick<DetectionService, "states" | "uptimeDays" | "uptime">;
  maintenance: Pick<MaintenanceService, "list">;
  /* What the workspace's plan allows (from billing, handed in by the composition root). */
  plan: (scope: WorkspaceScope) => Promise<{ limits: PlanLimits; features: PlanFeatures }>;
  guards: { session: RequestHandler; workspace: RequestHandler };
  /* Drafts public updates (§6.6). */
  ai: Pick<AiService, "generate" | "configured">;
}

const DOMAIN_SWEEP_MS = 5 * 60_000;
const AUTO_INCIDENT_SWEEP_MS = 30_000;

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
    cnameTarget: config.statusPages.cnameTarget,
    dns: deps.infra.dns,
    ai: deps.ai,
  });
  const controller = createStatuspagesController(service);
  return {
    name: "statuspages",
    service,
    routers: [
      { path: "/api/w/:workspaceId", router: createStatuspagesRouter(controller, deps.guards) },
      { path: "/api/public/status", router: createPublicStatusRouter(controller) },
      {
        path: "/api/public/status-subscriptions",
        router: createSubscriptionLinksRouter(controller),
      },
      { path: "/api/internal/tls", router: createInternalTlsRouter(controller) },
    ],
    processors: createStatuspagesProcessors(service, deps.infra.db),
    sweeps: [
      {
        kind: "status-domains",
        everyMs: DOMAIN_SWEEP_MS,
        async run(logger) {
          const checked = await service.checkDomains();
          if (checked > 0) logger.info({ checked }, "status page domains checked");
        },
      },
      {
        /* Opens a page incident once a monitor has been down as long as the page allows. */
        kind: "status-auto-incidents",
        everyMs: AUTO_INCIDENT_SWEEP_MS,
        async run(logger) {
          const { opened, resolved } = await service.autoIncidents();
          if (opened + resolved > 0) {
            logger.info({ opened, resolved }, "automatic status page incidents");
          }
        },
      },
    ],
  };
}
