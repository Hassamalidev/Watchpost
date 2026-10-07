/* Public API of the alerting module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { RequestHandler } from "express";
import type { AppModule, Infra } from "../../composition/types.js";
import { newId } from "../../infra/ids.js";
import type { ChannelsService } from "../channels/index.js";
import type { ContactsService } from "../contacts/index.js";
import type { CreditsService } from "../credits/index.js";
import type { IncidentsService } from "../incidents/index.js";
import type { OncallService } from "../oncall/index.js";
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
  EscalationOutcome,
  TimerJob,
} from "./alerting.service.js";
export { NOTIFY_ATTEMPTS, RetryDeliveryError } from "./alerting.service.js";

export interface AlertingModuleDeps {
  infra: Pick<Infra, "db" | "clock" | "outbox" | "logger" | "queues" | "config">;
  incidents: IncidentsService;
  channels: ChannelsService;
  workspaces: WorkspacesService;
  /* Personal contact methods and rules (§9.5); optional so tests can build alerting without them. */
  contacts?: Pick<ContactsService, "fanOut" | "pushSubscription" | "dropPush">;
  /* Escalation policies and who is on call (§9.5); optional like contacts. */
  oncall?: Pick<OncallService, "escalationPolicy" | "whoIsOnCall">;
  /* False-alarm refunds (§5); optional so tests can build alerting without credits. */
  credits?: Pick<CreditsService, "refundIncident" | "refundCharge">;
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
    contacts: deps.contacts,
    oncall: deps.oncall,
    credits: deps.credits,
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
    processors: createAlertingProcessors(service, infra.db, deps.credits),
    /* Lost notify jobs and reminder timers are rebuilt from Postgres on every worker start. */
    recoverySweeps: [
      { name: "notify-deliveries", run: () => service.recoverDeliveries() },
      { name: "reminders", run: () => service.recoverReminders() },
      { name: "escalations", run: () => service.recoverEscalations() },
    ],
    /* A job can also go missing while the worker runs (Redis eviction, a crash mid-send). */
    sweeps: [
      {
        kind: "notify-deliveries",
        everyMs: 60_000,
        async run(logger) {
          const requeued = await service.recoverDeliveries();
          if (requeued > 0) logger.warn({ requeued }, "re-queued lost notify jobs");
        },
      },
    ],
  };
}
