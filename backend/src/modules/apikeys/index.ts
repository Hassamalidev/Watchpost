/* Public API of the apikeys module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { RequestHandler } from "express";
import type { PlanFeature } from "@app/shared";
import type { AppModule, Infra } from "../../composition/types.js";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import { newId } from "../../infra/ids.js";
import type { WorkspacesService } from "../workspaces/index.js";
import { createApikeysController } from "./apikeys.controller.js";
import { createApiKeyGuards } from "./apikeys.guards.js";
import { apikeysPublicRoutes } from "./apikeys.public.js";
import { createApikeysRepository } from "./apikeys.repository.js";
import { createApikeysRouter } from "./apikeys.routes.js";
import { createApikeysService, type ApikeysService } from "./apikeys.service.js";

export type { ApikeysService };

export interface ApikeysModuleDeps {
  infra: Pick<Infra, "db" | "clock" | "redis">;
  workspaces: Pick<WorkspacesService, "workspaceName">;
  /* The billing module's answer to "does this workspace's plan include it?". */
  hasFeature: (scope: WorkspaceScope, feature: PlanFeature) => Promise<boolean>;
  guards: { session: RequestHandler; workspace: RequestHandler };
  /* Requests per key and minute; the default is the documented limit. */
  limitPerMinute?: number | undefined;
}

export interface ApikeysModule extends AppModule {
  service: ApikeysService;
}

export function createApikeysModule(deps: ApikeysModuleDeps): ApikeysModule {
  const service = createApikeysService({
    repository: createApikeysRepository(deps.infra.db),
    hasFeature: deps.hasFeature,
    workspaceName: (scope) => deps.workspaces.workspaceName(scope),
    clock: deps.infra.clock,
    newId,
  });
  const controller = createApikeysController(service);
  return {
    name: "apikeys",
    service,
    routers: [
      { path: "/api/w/:workspaceId", router: createApikeysRouter(controller, deps.guards) },
    ],
    publicApiGuards: createApiKeyGuards({
      service,
      redis: deps.infra.redis,
      limitPerMinute: deps.limitPerMinute,
    }),
    publicRoutes: apikeysPublicRoutes(service),
    sweeps: [
      {
        kind: "idempotency-keys-purge",
        everyMs: 3_600_000,
        async run(logger) {
          const deleted = await service.purgeIdempotencyKeys();
          if (deleted > 0) logger.info({ deleted }, "old idempotency keys deleted");
        },
      },
    ],
  };
}
