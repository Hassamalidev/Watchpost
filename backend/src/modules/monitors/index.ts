/* Public API of the monitors module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { AppModule, Infra } from "../../composition/types.js";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import { freeLimits, type PlanLimits } from "../../config/plans.js";
import { newId } from "../../infra/ids.js";
import type { WorkspaceGuards } from "../workspaces/index.js";
import { createMonitorsController } from "./monitors.controller.js";
import { createMonitorsRepository } from "./monitors.repository.js";
import { createMonitorsRouter } from "./monitors.routes.js";
import { createMonitorsService, type MonitorsService } from "./monitors.service.js";
import { createMonitorsProcessors } from "./jobs/index.js";

export type {
  MonitorForDetection,
  MonitorForProbe,
  MonitorGroupView,
  MonitorView,
  MonitorsService,
  PlanEnforcement,
  UpdateMonitorInput,
} from "./monitors.service.js";
export { MASKED } from "./types/secrets.js";

export interface MonitorsModuleDeps {
  infra: Pick<Infra, "db" | "clock" | "outbox" | "cipher"> & Partial<Pick<Infra, "logger">>;
  guards: WorkspaceGuards;
  /* Plan limits for a workspace; Free until entitlements land (P3-T01). */
  limits?: (scope: WorkspaceScope) => Promise<PlanLimits>;
}

export interface MonitorsModule extends AppModule {
  service: MonitorsService;
}

export function createMonitorsModule(deps: MonitorsModuleDeps): MonitorsModule {
  const repository = createMonitorsRepository(deps.infra.db);
  const service = createMonitorsService({
    db: deps.infra.db,
    repository,
    outbox: deps.infra.outbox,
    clock: deps.infra.clock,
    cipher: deps.infra.cipher,
    newId,
    limits: deps.limits ?? (async () => freeLimits()),
    onSecretError: (monitorId, err) =>
      deps.infra.logger?.error(
        { monitorId, err: (err as Error).message },
        "monitor secrets can't be decrypted; monitor skipped for probes",
      ),
  });
  const controller = createMonitorsController(service);
  return {
    name: "monitors",
    service,
    routers: [
      { path: "/api/w/:workspaceId", router: createMonitorsRouter(controller, deps.guards) },
    ],
    processors: createMonitorsProcessors(service, deps.infra.db),
  };
}
