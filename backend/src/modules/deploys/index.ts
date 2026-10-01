/* Public API of the deploys module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { RequestHandler } from "express";
import type { AppModule, Infra } from "../../composition/types.js";
import { newId } from "../../infra/ids.js";
import { createDeploysRepository } from "./deploys.repository.js";
import { createDeployIngestRouter, createDeploysRouter } from "./deploys.routes.js";
import { createDeploysService, type DeploysService } from "./deploys.service.js";

export type { DeployView, DeploysService } from "./deploys.service.js";

/* A deploy this close before an incident is worth naming in the alert. */
export const DEPLOY_SUSPECT_MINUTES = 30;

export interface DeploysModuleDeps {
  infra: Pick<Infra, "db" | "clock" | "logger" | "config" | "redis">;
  guards: { session: RequestHandler; workspace: RequestHandler };
}

export interface DeploysModule extends AppModule {
  service: DeploysService;
}

export function createDeploysModule(deps: DeploysModuleDeps): DeploysModule {
  const { infra } = deps;
  const service = createDeploysService({
    db: infra.db,
    repository: createDeploysRepository(),
    clock: infra.clock,
    logger: infra.logger.child({ module: "deploys" }),
    newId,
    publicOrigin: infra.config.webOrigin,
    authSecret: infra.config.auth.secret,
  });
  return {
    name: "deploys",
    service,
    routers: [{ path: "/api/w/:workspaceId", router: createDeploysRouter(service, deps.guards) }],
    rawBodyRouters: [
      { path: "/api/deploys", router: createDeployIngestRouter(service, infra.redis) },
    ],
  };
}
