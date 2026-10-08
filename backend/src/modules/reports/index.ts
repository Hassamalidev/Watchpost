/* Public API of the reports module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { RequestHandler } from "express";
import type { PlanFeature } from "@app/shared";
import type { AppModule, Infra } from "../../composition/types.js";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import { newId } from "../../infra/ids.js";
import { createTokenSigner } from "../../infra/signed-token.js";
import type { AiService } from "../ai/index.js";
import type { DetectionService } from "../detection/index.js";
import type { IncidentsService } from "../incidents/index.js";
import type { MonitorsService } from "../monitors/index.js";
import type { RollupsService } from "../results/index.js";
import type { StatuspagesService } from "../statuspages/index.js";
import type { WorkspacesService } from "../workspaces/index.js";
import { createReportsController } from "./reports.controller.js";
import { createReportsRepository } from "./reports.repository.js";
import { createPublicReportsRouter, createReportsRouter } from "./reports.routes.js";
import { createReportsService, type ReportsService } from "./reports.service.js";

export type { ReportsService, SlaQuery } from "./reports.service.js";

export interface ReportsModuleDeps {
  infra: Pick<Infra, "db" | "clock" | "outbox" | "logger" | "config">;
  workspaces: WorkspacesService;
  incidents: IncidentsService;
  detection: DetectionService;
  monitors: MonitorsService;
  results: Pick<RollupsService, "latencyBetween">;
  statuspages: Pick<StatuspagesService, "get">;
  ai: Pick<AiService, "generate" | "configured">;
  /* The billing module's answer to "does this workspace's plan include it?". */
  hasFeature: (scope: WorkspaceScope, feature: PlanFeature) => Promise<boolean>;
  guards: { session: RequestHandler; workspace: RequestHandler };
}

export interface ReportsModule extends AppModule {
  service: ReportsService;
}

export function createReportsModule(deps: ReportsModuleDeps): ReportsModule {
  const secret = deps.infra.config.auth.secret;
  const service = createReportsService({
    db: deps.infra.db,
    repository: createReportsRepository(),
    workspaces: deps.workspaces,
    incidents: deps.incidents,
    detection: deps.detection,
    monitors: deps.monitors,
    results: deps.results,
    statuspages: deps.statuspages,
    ai: deps.ai,
    hasFeature: deps.hasFeature,
    linkSigner: createTokenSigner(secret, "report-link"),
    unsubscribeSigner: createTokenSigner(secret, "report-unsubscribe"),
    outbox: deps.infra.outbox,
    clock: deps.infra.clock,
    logger: deps.infra.logger.child({ module: "reports" }),
    newId,
    webOrigin: deps.infra.config.webOrigin,
  });
  const controller = createReportsController(service);
  return {
    name: "reports",
    service,
    routers: [
      { path: "/api/w/:workspaceId", router: createReportsRouter(controller, deps.guards) },
      { path: "/api/public/reports", router: createPublicReportsRouter(controller) },
    ],
    /* Hourly: each send happens once per period, from 08:00 UTC on the day after it ended. */
    sweeps: [
      {
        kind: "weekly-digest",
        everyMs: 3_600_000,
        async run(logger) {
          const sent = await service.sendWeeklyDigests();
          if (sent > 0) logger.info({ sent }, "weekly digests sent");
        },
      },
      {
        kind: "scheduled-reports",
        everyMs: 3_600_000,
        async run(logger) {
          const sent = await service.sendScheduledReports();
          if (sent > 0) logger.info({ sent }, "scheduled reports sent");
        },
      },
      {
        kind: "monthly-uptime-email",
        everyMs: 3_600_000,
        async run(logger) {
          const sent = await service.sendMonthlyEmails();
          if (sent > 0) logger.info({ sent }, "monthly uptime emails sent");
        },
      },
    ],
  };
}
