/* Public API of the detection module. Other modules import only from this file (PRODUCT.md §7.1). */
import { Router } from "express";
import type { AppModule, Infra } from "../../composition/types.js";
import { probeOf } from "../../middleware/probe-auth.js";
import type { MonitorsService } from "../monitors/index.js";
import type { ProbesService } from "../probes/index.js";
import type { ResultsService } from "../results/index.js";
import { createDetectionService, type DetectionService } from "./detection.service.js";

export type { DetectionService, IngestResponse } from "./detection.service.js";

export interface DetectionModuleDeps {
  infra: Pick<Infra, "db" | "logger">;
  monitors: MonitorsService;
  results: ResultsService;
  probes: ProbesService;
}

export interface DetectionModule extends AppModule {
  service: DetectionService;
}

export function createDetectionModule(deps: DetectionModuleDeps): DetectionModule {
  const service = createDetectionService({
    db: deps.infra.db,
    monitors: deps.monitors,
    results: deps.results,
    probes: deps.probes,
    logger: deps.infra.logger.child({ module: "detection" }),
  });
  /* POST /api/probe/v1/results (mounted behind probe auth by the container). */
  const probeRouter = Router();
  probeRouter.post("/results", async (req, res) => {
    res.status(202).json(await service.ingest(probeOf(res), req.body));
  });
  return { name: "detection", service, probeRouters: [probeRouter] };
}
