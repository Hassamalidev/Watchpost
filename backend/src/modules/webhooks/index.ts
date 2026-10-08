/* Public API of the webhooks module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { RequestHandler } from "express";
import type { PlanFeature } from "@app/shared";
import type { AppModule, Infra } from "../../composition/types.js";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import { newId } from "../../infra/ids.js";
import type { IncidentsService } from "../incidents/index.js";
import type { MonitorsService } from "../monitors/index.js";
import { createWebhooksEventHandlers } from "./events/index.js";
import { createWebhooksProcessors } from "./jobs/index.js";
import { createWebhooksController } from "./webhooks.controller.js";
import { createWebhooksRepository } from "./webhooks.repository.js";
import { createWebhooksRouter } from "./webhooks.routes.js";
import { createWebhooksService, type WebhooksService } from "./webhooks.service.js";

export type { WebhooksService };
export { signWebhookBody } from "./webhooks.service.js";

export interface WebhooksModuleDeps {
  infra: Pick<Infra, "db" | "clock" | "logger" | "http" | "cipher" | "config">;
  incidents: Pick<IncidentsService, "get">;
  monitors: Pick<MonitorsService, "getForDetection">;
  /* The billing module's answer to "does this workspace's plan include it?". */
  hasFeature: (scope: WorkspaceScope, feature: PlanFeature) => Promise<boolean>;
  guards: { session: RequestHandler; workspace: RequestHandler };
}

export interface WebhooksModule extends AppModule {
  service: WebhooksService;
}

export function createWebhooksModule(deps: WebhooksModuleDeps): WebhooksModule {
  const { infra } = deps;
  const service = createWebhooksService({
    repository: createWebhooksRepository(infra.db),
    http: infra.http,
    cipher: infra.cipher,
    hasFeature: deps.hasFeature,
    clock: infra.clock,
    logger: infra.logger.child({ module: "webhooks" }),
    newId,
  });
  const handlers = createWebhooksEventHandlers({
    service,
    incidents: deps.incidents,
    monitors: deps.monitors,
    webOrigin: infra.config.webOrigin,
  });
  return {
    name: "webhooks",
    service,
    routers: [
      {
        path: "/api/w/:workspaceId",
        router: createWebhooksRouter(createWebhooksController(service), deps.guards),
      },
    ],
    processors: createWebhooksProcessors(handlers, infra.db),
    sweeps: [
      {
        /* Retries: a pending delivery is attempted within a minute of being due. */
        kind: "webhook-deliveries",
        everyMs: 60_000,
        async run(logger) {
          const attempted = await service.deliverDue();
          if (attempted > 0) logger.info({ attempted }, "webhook deliveries attempted");
        },
      },
      {
        kind: "webhook-deliveries-purge",
        everyMs: 86_400_000,
        async run(logger) {
          const deleted = await service.purgeDeliveries();
          if (deleted > 0) logger.info({ deleted }, "old webhook deliveries deleted");
        },
      },
    ],
  };
}
