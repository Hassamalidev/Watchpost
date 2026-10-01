/* Public API of the alerting module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { RequestHandler } from "express";
import type { AppModule, Infra } from "../../composition/types.js";
import { newId } from "../../infra/ids.js";
import type { ChannelsService } from "../channels/index.js";
import type { IncidentsService } from "../incidents/index.js";
import type { WorkspacesService } from "../workspaces/index.js";
import { createAlertingController } from "./alerting.controller.js";
import { createAlertingRepository } from "./alerting.repository.js";
import { createAlertingRouter } from "./alerting.routes.js";
import { createAlertingService, type AlertingService } from "./alerting.service.js";
import { createAlertingProcessors } from "./jobs/index.js";

export type {
  AlertPolicyView,
  AlertingService,
  DeliveryLogEntry,
  DeliveryOutcome,
  DeliveryView,
  TimerJob,
} from "./alerting.service.js";
export { NOTIFY_ATTEMPTS, RetryDeliveryError } from "./alerting.service.js";

export interface AlertingModuleDeps {
  infra: Pick<Infra, "db" | "clock" | "outbox" | "logger" | "queues" | "config">;
  incidents: IncidentsService;
  channels: ChannelsService;
  workspaces: WorkspacesService;
  guards: { session: RequestHandler; workspace: RequestHandler };
}

export interface AlertingModule extends AppModule {
  service: AlertingService;
}

export function createAlertingModule(deps: AlertingModuleDeps): AlertingModule {
  const { infra } = deps;
  const service = createAlertingService({
    db: infra.db,
    repository: createAlertingRepository(),
    incidents: deps.incidents,
    channels: deps.channels,
    workspaces: deps.workspaces,
    outbox: infra.outbox,
    clock: infra.clock,
    logger: infra.logger.child({ module: "alerting" }),
    newId,
    webOrigin: infra.config.webOrigin,
    enqueueNotify: (deliveryId, options) =>
      infra.queues.enqueue("notify", "notify", { deliveryId }, options),
    enqueueTimer: (job, options) => infra.queues.enqueue("timers", job.kind, job, options),
  });
  return {
    name: "alerting",
    service,
    routers: [
      {
        path: "/api/w/:workspaceId",
        router: createAlertingRouter(createAlertingController(service), deps.guards),
      },
    ],
    processors: createAlertingProcessors(service, infra.db),
    /* Lost notify jobs and reminder timers are rebuilt from Postgres on every worker start. */
    recoverySweeps: [
      { name: "notify-deliveries", run: () => service.recoverDeliveries() },
      { name: "reminders", run: () => service.recoverReminders() },
    ],
  };
}
