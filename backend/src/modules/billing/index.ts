/* Public API of the billing module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { RequestHandler } from "express";
import type { AppModule, Infra } from "../../composition/types.js";
import { createPriceCatalog } from "../../config/plans.js";
import { newId } from "../../infra/ids.js";
import { buildJobId } from "../../infra/queues/index.js";
import { createQuotaGuard, type RequireFeature } from "../../middleware/quota.js";
import type { WorkspacesService } from "../workspaces/index.js";
import { createBillingController } from "./billing.controller.js";
import { createBillingRepository } from "./billing.repository.js";
import { createBillingRouter, createPaddleWebhookRouter } from "./billing.routes.js";
import { createBillingService, type BillingService } from "./billing.service.js";
import { createBillingEventHandlers } from "./events/index.js";
import { createBillingProcessors } from "./jobs/index.js";
import { createPaddleSync, type PaddleRuntime, type PaddleSync } from "./paddle-sync.js";
import { createPlanSync } from "./plan-sync.js";
import { createTrialService, type TrialService } from "./trial.js";

export type { BillingService, PaidSubscription } from "./billing.service.js";
export type { EventOutcome, IngestOutcome, PaddleSync } from "./paddle-sync.js";
export type { PlanChange } from "./plan-sync.js";
export type { TrialNotice, TrialService } from "./trial.js";

export interface BillingModuleDeps {
  infra: Pick<
    Infra,
    "db" | "clock" | "outbox" | "logger" | "config" | "queues" | "locks" | "redis" | "paddle"
  >;
  workspaces: WorkspacesService;
  guards: { session: RequestHandler; workspace: RequestHandler };
}

export interface BillingModule extends AppModule {
  service: BillingService;
  sync: PaddleSync;
  trial: TrialService;
  /* Route guard for plan features, for modules that sell one (SSO, SLA reports, …). */
  requireFeature: RequireFeature;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export function createBillingModule(deps: BillingModuleDeps): BillingModule {
  const { infra } = deps;
  const logger = infra.logger.child({ module: "billing" });
  const repository = createBillingRepository();
  const catalog = createPriceCatalog(infra.config.prices);
  const paddle: PaddleRuntime | undefined =
    infra.paddle === undefined || infra.config.paddle === undefined
      ? undefined
      : {
          api: infra.paddle.api,
          webhooks: infra.paddle.webhooks,
          environment: infra.config.paddle.environment,
          clientToken: infra.config.paddle.clientToken,
          foundingDiscountId: infra.config.paddle.foundingDiscountId,
        };

  const planSync = createPlanSync({
    repository,
    workspaces: deps.workspaces,
    outbox: infra.outbox,
    clock: infra.clock,
    catalog,
  });
  const sync = createPaddleSync({
    db: infra.db,
    repository,
    planSync,
    workspaces: deps.workspaces,
    outbox: infra.outbox,
    clock: infra.clock,
    logger,
    newId,
    catalog,
    paddle,
    authSecret: infra.config.auth.secret,
    webOrigin: infra.config.webOrigin,
    enqueue: (eventId, jobSuffix) => {
      /* Paddle's IDs look like evt_01h…; anything else is made safe for a job ID. */
      const part = eventId.replace(/[^A-Za-z0-9_-]/g, "_");
      return infra.queues.enqueue(
        "billing",
        "paddle-event",
        { eventId },
        {
          jobId:
            jobSuffix === undefined
              ? buildJobId("paddle", part)
              : buildJobId("paddle", part, jobSuffix),
        },
      );
    },
  });
  const service = createBillingService({
    db: infra.db,
    repository,
    planSync,
    paddleSync: sync,
    workspaces: deps.workspaces,
    clock: infra.clock,
    logger,
    locks: infra.locks,
    catalog,
    paddle,
  });
  const trial = createTrialService({
    db: infra.db,
    repository,
    workspaces: deps.workspaces,
    paddleSync: sync,
    clock: infra.clock,
    logger,
  });

  return {
    name: "billing",
    service,
    sync,
    trial,
    requireFeature: createQuotaGuard(service.hasFeature),
    routers: [
      {
        path: "/api/w/:workspaceId",
        router: createBillingRouter(createBillingController(service), deps.guards),
      },
    ],
    rawBodyRouters: [
      { path: "/api/webhooks/paddle", router: createPaddleWebhookRouter(sync, infra.redis) },
    ],
    processors: createBillingProcessors({
      db: infra.db,
      handlers: createBillingEventHandlers({ service, trial, workspaces: deps.workspaces }),
      sync,
    }),
    recoverySweeps: [
      /* Stored Paddle events whose job was lost are the source of every `billing` job. */
      { name: "billing-events", run: () => sync.recover() },
      { name: "billing-accounts", run: () => service.backfillAccounts() },
    ],
    sweeps: [
      {
        kind: "billing-events",
        everyMs: MINUTE_MS,
        async run(jobLogger) {
          const requeued = await sync.recover();
          if (requeued > 0) jobLogger.warn({ requeued }, "re-queued unprocessed Paddle events");
        },
      },
      {
        /* Trial ends, payment grace ends and downgrade dates take effect here. */
        kind: "billing-clock",
        everyMs: MINUTE_MS,
        async run(jobLogger) {
          const changed = await service.runClock();
          if (changed > 0) jobLogger.info({ changed }, "plans changed on schedule");
        },
      },
      {
        kind: "billing-trials",
        everyMs: HOUR_MS,
        async run(jobLogger) {
          const sent = await trial.sweep();
          if (sent > 0) jobLogger.info({ sent }, "trial emails sent");
        },
      },
      {
        /* Nightly comparison with Paddle catches anything a lost webhook left behind (§11). */
        kind: "billing-reconcile",
        everyMs: 24 * HOUR_MS,
        async run(jobLogger) {
          jobLogger.info(await sync.reconcile(), "subscriptions reconciled with Paddle");
        },
      },
    ],
    hooks: { memberLimit: (workspaceId) => service.memberLimit(workspaceId) },
  };
}
