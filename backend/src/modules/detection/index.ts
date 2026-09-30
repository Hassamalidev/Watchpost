/* Public API of the detection module. Other modules import only from this file (PRODUCT.md §7.1). */
import { Router } from "express";
import type { AppModule, Infra } from "../../composition/types.js";
import { newId } from "../../infra/ids.js";
import { probeOf } from "../../middleware/probe-auth.js";
import type { IncidentsService } from "../incidents/index.js";
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
  DetectionJob,
  DetectionService,
  EvaluationOutcome,
  IngestResponse,
} from "./detection.service.js";
export type { DowntimeKind, MonitorStateRow, RegionStatus } from "./schema/detection.js";

export interface DetectionModuleDeps {
  infra: Pick<Infra, "db" | "logger" | "outbox" | "clock" | "queues">;
  monitors: MonitorsService;
  results: ResultsService;
  probes: ProbesService;
  incidents: IncidentsService;
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
  return {
    name: "detection",
    service,
    probeRouters: [probeRouter],
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
