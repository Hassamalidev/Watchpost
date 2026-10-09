/* Public API of the privacy module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { RequestHandler } from "express";
import type { AppModule, Infra } from "../../composition/types.js";
import { eraseWorkspaceRows } from "../../infra/db/erase-workspace.js";
import { createPrivacyController } from "./privacy.controller.js";
import { createPrivacyRepository } from "./privacy.repository.js";
import { createPrivacyRouter } from "./privacy.routes.js";
import {
  createPrivacyService,
  type PrivacyService,
  type PrivacyServiceDeps,
} from "./privacy.service.js";

export type { PrivacyService };

export interface PrivacyModuleDeps extends Pick<
  PrivacyServiceDeps,
  | "workspaces"
  | "billing"
  | "monitors"
  | "incidents"
  | "maintenance"
  | "channels"
  | "contacts"
  | "oncall"
  | "statuspages"
  | "results"
> {
  infra: Pick<Infra, "db" | "outbox" | "clock" | "logger" | "config">;
  guards: { session: RequestHandler; workspace: RequestHandler };
}

export interface PrivacyModule extends AppModule {
  service: PrivacyService;
}

const ERASE_SWEEP_MS = 60 * 60_000;

export function createPrivacyModule(deps: PrivacyModuleDeps): PrivacyModule {
  const { infra, guards, ...services } = deps;
  const service = createPrivacyService({
    ...services,
    db: infra.db,
    repository: createPrivacyRepository(infra.db),
    clock: infra.clock,
    logger: infra.logger,
    outbox: infra.outbox,
    webOrigin: infra.config.webOrigin,
    eraseRows: (workspaceId) => eraseWorkspaceRows(infra.db, workspaceId),
  });
  const controller = createPrivacyController(service);
  return {
    name: "privacy",
    service,
    routers: [{ path: "/api/w/:workspaceId", router: createPrivacyRouter(controller, guards) }],
    sweeps: [
      {
        /* Workspaces whose 30 days are over are erased, a few an hour. */
        kind: "privacy-erase",
        everyMs: ERASE_SWEEP_MS,
        async run(logger) {
          const erased = await service.eraseDue();
          if (erased > 0) logger.info({ erased }, "workspaces erased");
        },
      },
    ],
  };
}
