/* Public API of the detection module. Other modules import only from this file (PRODUCT.md §7.1). */
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import type { AppModule, Infra } from "../../composition/types.js";
import { newId } from "../../infra/ids.js";
import { probeOf } from "../../middleware/probe-auth.js";
import { requirePermission } from "../../middleware/roles.js";
import { inputOf, validate } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import type { DeploysService } from "../deploys/index.js";
import type { IncidentsService } from "../incidents/index.js";
import type { MaintenanceService } from "../maintenance/index.js";
import type { MonitorsService } from "../monitors/index.js";
import type { ProbesService } from "../probes/index.js";
import type { ResultsService } from "../results/index.js";
import { createDetectionRepository } from "./detection.repository.js";
import {
  SWEEP_EVERY_MS,
  createDetectionService,
  type DetectionService,
} from "./detection.service.js";
import { createDetectionProcessors } from "./jobs/index.js";

export type {
  MonitorStateView,
  DetectionJob,
  DetectionService,
  EvaluationOutcome,
  IngestResponse,
} from "./detection.service.js";
export type { DowntimeKind, MonitorStateRow, RegionStatus } from "./schema/detection.js";
export type { DayStatus, UptimeDay, UptimeSummary } from "./uptime.js";
export { combineUptime } from "./uptime.js";
export type { ChangeEvent, ChangeKind } from "./changes.js";
export type { BudgetStatus, ErrorBudget } from "./slo.js";

export interface DetectionModuleDeps {
  infra: Pick<Infra, "db" | "logger" | "outbox" | "clock" | "queues">;
  monitors: MonitorsService;
  results: ResultsService;
  probes: ProbesService;
  incidents: IncidentsService;
  deploys: DeploysService;
  /* Maintenance windows; optional so tests can build detection without them. */
  maintenance?: Pick<MaintenanceService, "inMaintenance" | "boundaryChanges"> | undefined;
  guards: { session: RequestHandler; workspace: RequestHandler };
}

const monitorParams = z.object({ monitorId: z.uuid() });
const flag = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");
const uptimeQuery = z
  .object({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    excludeMaintenance: flag,
  })
  .refine((q) => !q.from || !q.to || q.from < q.to, "from must be before to");
const changesQuery = z.object({
  before: z.iso.datetime({ offset: true }).optional(),
  hours: z.coerce.number().int().min(1).max(48).default(24),
});
const daysQuery = z.object({
  days: z.coerce.number().int().min(1).max(366).default(90),
  excludeMaintenance: flag,
});

/* /api/w/:workspaceId/monitors/:monitorId/uptime[/days] (viewers and above). */
function createUptimeRouter(
  service: DetectionService,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  const read = [guards.session, guards.workspace, requirePermission("monitor:read")];
  router.get("/monitor-states", ...read, async (req, res) => {
    const scope = scopeOf(req, res);
    res.json({
      data: await service.states(scope),
      /* Regions whose checks don't count right now (our probe there is quarantined or silent). */
      reducedRegions: await service.reducedRegions(scope),
    });
  });
  router.get(
    "/monitors/:monitorId/uptime",
    ...read,
    validate({ params: monitorParams, query: uptimeQuery }),
    async (req, res) => {
      const { params, query } = inputOf<{
        params: typeof monitorParams;
        query: typeof uptimeQuery;
      }>(req, res);
      const to = query.to ? new Date(query.to) : new Date();
      const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 86_400_000);
      res.json(
        await service.uptime(scopeOf(req, res), params.monitorId, {
          from,
          to,
          excludeMaintenance: query.excludeMaintenance,
        }),
      );
    },
  );
  router.get("/error-budgets", ...read, async (req, res) => {
    res.json({ data: await service.errorBudgets(scopeOf(req, res)) });
  });
  router.get(
    "/monitors/:monitorId/error-budget",
    ...read,
    validate({ params: monitorParams }),
    async (req, res) => {
      const { params } = inputOf<{ params: typeof monitorParams }>(req, res);
      res.json(await service.errorBudget(scopeOf(req, res), params.monitorId));
    },
  );
  router.get(
    "/monitors/:monitorId/changes",
    ...read,
    validate({ params: monitorParams, query: changesQuery }),
    async (req, res) => {
      const { params, query } = inputOf<{
        params: typeof monitorParams;
        query: typeof changesQuery;
      }>(req, res);
      res.json({
        data: await service.changesBefore(scopeOf(req, res), params.monitorId, {
          before: query.before ? new Date(query.before) : new Date(),
          hours: query.hours,
        }),
      });
    },
  );
  router.get(
    "/monitors/:monitorId/uptime/days",
    ...read,
    validate({ params: monitorParams, query: daysQuery }),
    async (req, res) => {
      const { params, query } = inputOf<{ params: typeof monitorParams; query: typeof daysQuery }>(
        req,
        res,
      );
      res.json({ data: await service.uptimeDays(scopeOf(req, res), params.monitorId, query) });
    },
  );
  return router;
}

export interface DetectionModule extends AppModule {
  service: DetectionService;
}

export function createDetectionModule(deps: DetectionModuleDeps): DetectionModule {
  const service = createDetectionService({
    db: deps.infra.db,
    repository: createDetectionRepository(),
    monitors: deps.monitors,
    results: deps.results,
    probes: deps.probes,
    incidents: deps.incidents,
    deploys: deps.deploys,
    maintenance: deps.maintenance,
    outbox: deps.infra.outbox,
    clock: deps.infra.clock,
    logger: deps.infra.logger.child({ module: "detection" }),
    newId,
    enqueue: (job, options) => deps.infra.queues.enqueue("evaluate", job.kind, job, options),
  });
  /* POST /api/probe/v1/results (mounted behind probe auth by the container). */
  const probeRouter = Router();
  probeRouter.post("/results", async (req, res) => {
    res.status(202).json(await service.ingest(probeOf(res), req.body));
  });
  /* POST /api/probe/v1/diagnostics: what a probe found when asked to trace a failing target. */
  probeRouter.post("/diagnostics", async (req, res) => {
    res.status(202).json(await service.recordDiagnostics(probeOf(res), req.body));
  });
  return {
    name: "detection",
    service,
    probeRouters: [probeRouter],
    routers: [{ path: "/api/w/:workspaceId", router: createUptimeRouter(service, deps.guards) }],
    processors: createDetectionProcessors(service),
    recoverySweeps: [{ name: "detection-unevaluated", run: () => service.sweep() }],
    schedules: [
      {
        queue: "evaluate",
        id: "detection-sweep",
        everyMs: SWEEP_EVERY_MS,
        data: { kind: "sweep" },
      },
    ],
  };
}
