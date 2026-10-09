/* Public API of the audit module. Other modules import only from this file (PRODUCT.md §7.1). */
import { Router, type RequestHandler } from "express";
import type { PlanFeature } from "@app/shared";
import type { AppModule, Infra } from "../../composition/types.js";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import { newId } from "../../infra/ids.js";
import { createAuditController } from "./audit.controller.js";
import { createAuditRepository } from "./audit.repository.js";
import { createAuditRouter } from "./audit.routes.js";
import { createAuditService, type AuditService } from "./audit.service.js";
import { createAuditTrail } from "./audit.trail.js";

export type { AuditEntry, AuditService } from "./audit.service.js";

export interface AuditModuleDeps {
  infra: Pick<Infra, "db" | "clock" | "logger">;
  /* The billing module's answer to "does this workspace's plan include it?". */
  hasFeature: (scope: WorkspaceScope, feature: PlanFeature) => Promise<boolean>;
  guards: { session: RequestHandler; workspace: RequestHandler };
}

export interface AuditModule extends AppModule {
  service: AuditService;
}

export function createAuditModule(deps: AuditModuleDeps): AuditModule {
  const service = createAuditService({
    repository: createAuditRepository(deps.infra.db),
    hasFeature: deps.hasFeature,
    clock: deps.infra.clock,
    logger: deps.infra.logger.child({ module: "audit" }),
    newId,
  });
  /* Mounted first by the container, so it sees every request to the two APIs. */
  const trail = Router({ mergeParams: true });
  trail.use(createAuditTrail(service));
  return {
    name: "audit",
    service,
    routers: [
      { path: "/api/w/:workspaceId", router: trail },
      { path: "/api/v1", router: trail },
      {
        path: "/api/w/:workspaceId",
        router: createAuditRouter(createAuditController(service), deps.guards),
      },
    ],
    hooks: {
      /* People changes come from the auth library, not from our routes. */
      onSecurityEvent: (event) =>
        service.record({
          workspaceId: event.workspaceId,
          category: "security",
          action: event.action,
          actor:
            event.actor === undefined
              ? { type: "system", label: "System" }
              : { type: "user", id: event.actor.id, label: event.actor.email },
          targetId: event.targetId,
          detail: event.detail,
        }),
    },
    sweeps: [
      {
        kind: "audit-log-purge",
        everyMs: 86_400_000,
        async run(logger) {
          const deleted = await service.purge();
          if (deleted > 0) logger.info({ deleted }, "old audit entries deleted");
        },
      },
    ],
  };
}
