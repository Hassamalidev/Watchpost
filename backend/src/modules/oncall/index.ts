/* Public API of the oncall module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { RequestHandler } from "express";
import type { AppModule, Infra } from "../../composition/types.js";
import { newId } from "../../infra/ids.js";
import type { WorkspacesService } from "../workspaces/index.js";
import { createOncallController } from "./oncall.controller.js";
import { createOncallRepository } from "./oncall.repository.js";
import { createOncallRouter } from "./oncall.routes.js";
import { createOncallService, type OncallService } from "./oncall.service.js";

export type { OncallService } from "./oncall.service.js";

export interface OncallModuleDeps {
  infra: Pick<Infra, "db" | "clock">;
  workspaces: WorkspacesService;
  guards: { session: RequestHandler; workspace: RequestHandler };
}

export interface OncallModule extends AppModule {
  service: OncallService;
}

export function createOncallModule(deps: OncallModuleDeps): OncallModule {
  const service = createOncallService({
    db: deps.infra.db,
    repository: createOncallRepository(),
    workspaces: deps.workspaces,
    clock: deps.infra.clock,
    newId,
  });
  return {
    name: "oncall",
    service,
    routers: [
      {
        path: "/api/w/:workspaceId",
        router: createOncallRouter(createOncallController(service), deps.guards),
      },
    ],
  };
}
