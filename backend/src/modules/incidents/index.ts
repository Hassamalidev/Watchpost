/* Public API of the incidents module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { RequestHandler } from "express";
import type { AppModule, Infra } from "../../composition/types.js";
import { newId } from "../../infra/ids.js";
import type { MonitorsService } from "../monitors/index.js";
import type { WorkspacesService } from "../workspaces/index.js";
import { createIncidentsController } from "./incidents.controller.js";
import { createIncidentsRepository } from "./incidents.repository.js";
import { createIncidentsRouter } from "./incidents.routes.js";
import { createIncidentsService, type IncidentsService } from "./incidents.service.js";

export type {
  AlertContext,
  CommentView,
  CreateIncidentInput,
  ExpiryIncidentInput,
  IncidentSummary,
  IncidentDetail,
  IncidentView,
  IncidentsService,
  OpenForMonitorInput,
  TimelineEntry,
} from "./incidents.service.js";
export type {
  IncidentRow,
  IncidentSeverity,
  IncidentSource,
  IncidentStatus,
} from "./schema/incidents.js";

export interface IncidentsModuleDeps {
  infra: Pick<Infra, "db" | "clock" | "outbox">;
  workspaces: Pick<WorkspacesService, "nextIncidentNumber">;
  monitors: Pick<MonitorsService, "get" | "getForDetection">;
  guards: { session: RequestHandler; workspace: RequestHandler };
}

export interface IncidentsModule extends AppModule {
  service: IncidentsService;
}

export function createIncidentsModule(deps: IncidentsModuleDeps): IncidentsModule {
  const service = createIncidentsService({
    db: deps.infra.db,
    repository: createIncidentsRepository(),
    workspaces: deps.workspaces,
    monitors: deps.monitors,
    outbox: deps.infra.outbox,
    clock: deps.infra.clock,
    newId,
  });
  return {
    name: "incidents",
    service,
    routers: [
      {
        path: "/api/w/:workspaceId",
        router: createIncidentsRouter(createIncidentsController(service), deps.guards),
      },
    ],
  };
}
