/* Public API of the incidents module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { AppModule, Infra } from "../../composition/types.js";
import { newId } from "../../infra/ids.js";
import type { WorkspacesService } from "../workspaces/index.js";
import { createIncidentsRepository } from "./incidents.repository.js";
import { createIncidentsService, type IncidentsService } from "./incidents.service.js";

export type { IncidentsService, OpenForMonitorInput } from "./incidents.service.js";
export type { IncidentRow, IncidentStatus } from "./schema/incidents.js";

export interface IncidentsModuleDeps {
  infra: Pick<Infra, "db" | "clock" | "outbox">;
  workspaces: Pick<WorkspacesService, "nextIncidentNumber">;
}

export interface IncidentsModule extends AppModule {
  service: IncidentsService;
}

export function createIncidentsModule(deps: IncidentsModuleDeps): IncidentsModule {
  const service = createIncidentsService({
    repository: createIncidentsRepository(),
    workspaces: deps.workspaces,
    outbox: deps.infra.outbox,
    clock: deps.infra.clock,
    newId,
  });
  return { name: "incidents", service };
}
