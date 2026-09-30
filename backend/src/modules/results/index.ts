/* Public API of the results module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { AppModule, Infra } from "../../composition/types.js";
import { createResultsRepository } from "./results.repository.js";
import { createResultsService, type ResultsService } from "./results.service.js";
import { PARTITION_JOB_EVERY_MS, createResultsProcessors } from "./jobs/index.js";

export type { IngestOutcome, ResultsService, StoredResult } from "./results.service.js";
export type { CheckResultRow } from "./schema/partitioned/check-results.js";
export {
  MAX_FUTURE_SKEW_MS,
  MAX_RESULT_AGE_MS,
  PARTITIONS_AHEAD_DAYS,
  RAW_RETENTION_MS,
} from "./results.service.js";

export interface ResultsModuleDeps {
  infra: Pick<Infra, "db" | "clock">;
}

export interface ResultsModule extends AppModule {
  service: ResultsService;
}

export function createResultsModule(deps: ResultsModuleDeps): ResultsModule {
  const repository = createResultsRepository(deps.infra.db);
  const service = createResultsService({ db: deps.infra.db, repository, clock: deps.infra.clock });
  return {
    name: "results",
    service,
    processors: createResultsProcessors(service),
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
    ],
  };
}
