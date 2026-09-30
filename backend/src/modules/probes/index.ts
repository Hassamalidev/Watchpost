/* Public API of the probes module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { RequestHandler } from "express";
import type { AppModule, Infra } from "../../composition/types.js";
import { newId } from "../../infra/ids.js";
import { probeAuth } from "../../middleware/probe-auth.js";
import type { MonitorsService } from "../monitors/index.js";
import { createProbesController } from "./probes.controller.js";
import { createProbesRepository } from "./probes.repository.js";
import { createProbeProtocolRouter, createProbeUserRouter } from "./probes.routes.js";
import { createProbesService, type ProbesService } from "./probes.service.js";
import { createTaskNotifier } from "./types/task-notifier.js";

export type { ProbeTaskView, ProbesService } from "./probes.service.js";

export interface ProbesModuleDeps {
  infra: Pick<Infra, "db" | "pool" | "clock" | "cipher">;
  monitors: MonitorsService;
  guards: { session: RequestHandler; workspace: RequestHandler };
}

export interface ProbesModule extends AppModule {
  service: ProbesService;
}

export function createProbesModule(deps: ProbesModuleDeps): ProbesModule {
  const service = createProbesService({
    db: deps.infra.db,
    repository: createProbesRepository(deps.infra.db),
    monitors: deps.monitors,
    cipher: deps.infra.cipher,
    clock: deps.infra.clock,
    newId,
    notifier: createTaskNotifier(deps.infra.pool),
  });
  const controller = createProbesController(service);
  return {
    name: "probes",
    service,
    probeAuth: probeAuth({ lookup: (id) => service.authLookup(id) }),
    probeRouters: [createProbeProtocolRouter(controller)],
    routers: [
      { path: "/api/w/:workspaceId", router: createProbeUserRouter(controller, deps.guards) },
    ],
    close: () => service.close(),
  };
}
