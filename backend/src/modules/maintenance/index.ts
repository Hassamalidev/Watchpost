/* Public API of the maintenance module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { RequestHandler } from "express";
import type { AppModule, Infra } from "../../composition/types.js";
import { newId } from "../../infra/ids.js";
import type { MonitorsService } from "../monitors/index.js";
import { createMaintenanceController } from "./maintenance.controller.js";
import { createMaintenanceRepository } from "./maintenance.repository.js";
import { createMaintenanceRouter } from "./maintenance.routes.js";
import { createMaintenanceService, type MaintenanceService } from "./maintenance.service.js";

export type { BoundaryChange, MaintenanceService } from "./maintenance.service.js";
export { occurrencesBetween, type Occurrence } from "./recurrence.js";

export interface MaintenanceModuleDeps {
  infra: Pick<Infra, "db" | "clock">;
  monitors: Pick<MonitorsService, "getForDetection">;
  guards: { session: RequestHandler; workspace: RequestHandler };
}

export interface MaintenanceModule extends AppModule {
  service: MaintenanceService;
}

export function createMaintenanceModule(deps: MaintenanceModuleDeps): MaintenanceModule {
  const service = createMaintenanceService({
    repository: createMaintenanceRepository(deps.infra.db),
    monitors: deps.monitors,
    clock: deps.infra.clock,
    newId,
  });
  return {
    name: "maintenance",
    service,
    routers: [
      {
        path: "/api/w/:workspaceId",
        router: createMaintenanceRouter(createMaintenanceController(service), deps.guards),
      },
    ],
  };
}
