/* Public API of the reports module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { AppModule, Infra } from "../../composition/types.js";
import type { DetectionService } from "../detection/index.js";
import type { IncidentsService } from "../incidents/index.js";
import type { MonitorsService } from "../monitors/index.js";
import type { WorkspacesService } from "../workspaces/index.js";
import { createReportsRepository } from "./reports.repository.js";
import { createReportsService, type ReportsService } from "./reports.service.js";

export type { ReportsService } from "./reports.service.js";
export { weekStartOf } from "./reports.service.js";

export interface ReportsModuleDeps {
  infra: Pick<Infra, "db" | "clock" | "outbox" | "logger" | "config">;
  workspaces: WorkspacesService;
  incidents: IncidentsService;
  detection: DetectionService;
  monitors: MonitorsService;
}

export interface ReportsModule extends AppModule {
  service: ReportsService;
}

export function createReportsModule(deps: ReportsModuleDeps): ReportsModule {
  const service = createReportsService({
    db: deps.infra.db,
    repository: createReportsRepository(),
    workspaces: deps.workspaces,
    incidents: deps.incidents,
    detection: deps.detection,
    monitors: deps.monitors,
    outbox: deps.infra.outbox,
    clock: deps.infra.clock,
    logger: deps.infra.logger.child({ module: "reports" }),
    webOrigin: deps.infra.config.webOrigin,
  });
  return {
    name: "reports",
    service,
    /* Hourly: sends only once per workspace and week, from Monday 08:00 UTC. */
    sweeps: [
      {
        kind: "weekly-digest",
        everyMs: 3_600_000,
        async run(logger) {
          const sent = await service.sendWeeklyDigests();
          if (sent > 0) logger.info({ sent }, "weekly digests sent");
        },
      },
    ],
  };
}
