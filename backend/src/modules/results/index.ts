/* Public API of the results module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { RequestHandler } from "express";
import type { AppModule, Infra } from "../../composition/types.js";
import { newId } from "../../infra/ids.js";
import type { MonitorsService } from "../monitors/index.js";
import { createResultsRouter } from "./results.routes.js";
import { createRollupsService, type RollupsService } from "./rollups.service.js";
import { createResultsRepository } from "./results.repository.js";
import { createResultsService, type ResultsService } from "./results.service.js";
import { PARTITION_JOB_EVERY_MS, ROLLUP_EVERY_MS, createResultsProcessors } from "./jobs/index.js";

export type { IngestOutcome, ResultsService, StoredResult } from "./results.service.js";
export type { CheckResultRow } from "./schema/partitioned/check-results.js";
export type {
  ChartRange,
  CheckView,
  LatencyPoint,
  LatencySeries,
  LatencyTotals,
  RollupsService,
} from "./rollups.service.js";
export {
  MAX_EVIDENCE_PER_BATCH,
  MAX_FUTURE_SKEW_MS,
  MAX_RESULT_AGE_MS,
  PARTITIONS_AHEAD_DAYS,
  RAW_RETENTION_MS,
} from "./results.service.js";

export interface ResultsModuleDeps {
  infra: Pick<Infra, "db" | "clock" | "objects" | "logger">;
  monitors: Pick<MonitorsService, "get" | "planLimits">;
  guards: { session: RequestHandler; workspace: RequestHandler };
}

export interface ResultsModule extends AppModule {
  service: ResultsService;
  rollups: RollupsService;
}

export function createResultsModule(deps: ResultsModuleDeps): ResultsModule {
  const repository = createResultsRepository(deps.infra.db);
  const service = createResultsService({
    db: deps.infra.db,
    repository,
    clock: deps.infra.clock,
    newId,
    objects: deps.infra.objects,
    logger: deps.infra.logger.child({ module: "results" }),
  });
  const rollups = createRollupsService({
    repository,
    monitors: deps.monitors,
    clock: deps.infra.clock,
  });
  return {
    name: "results",
    service,
    rollups,
    routers: [{ path: "/api/w/:workspaceId", router: createResultsRouter(rollups, deps.guards) }],
    processors: createResultsProcessors(service, rollups),
    /* Partitions must exist before probes report after a long outage. */
    recoverySweeps: [
      {
        name: "check-results-partitions",
        run: async () => (await service.maintainPartitions()).created.length,
      },
    ],
    schedules: [
      {
        queue: "results",
        id: "check-results-partitions",
        everyMs: PARTITION_JOB_EVERY_MS,
        data: { kind: "partitions" },
      },
      ...(["5m", "1h", "1d"] as const).map((size) => ({
        queue: "results" as const,
        id: `rollup-${size}`,
        everyMs: ROLLUP_EVERY_MS[size],
        data: { kind: `rollup-${size}` },
      })),
    ],
  };
}
