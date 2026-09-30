/* BullMQ processors for the results module: partition maintenance and rollups on the `results` queue. */
import { z } from "zod";
import { defineProcessor, type JobProcessor } from "../../../infra/queues/index.js";
import type { ResultsService } from "../results.service.js";
import type { RollupsService } from "../rollups.service.js";

export const PARTITION_JOB_EVERY_MS = 3_600_000;
export const ROLLUP_EVERY_MS = { "5m": 5 * 60_000, "1h": 3_600_000, "1d": 86_400_000 } as const;

export function createResultsProcessors(
  service: ResultsService,
  rollups: RollupsService,
): JobProcessor[] {
  return [
    defineProcessor({
      queue: "results",
      schema: z.object({ kind: z.enum(["partitions", "rollup-5m", "rollup-1h", "rollup-1d"]) }),
      async handle({ kind }, { logger }) {
        if (kind === "partitions") {
          const outcome = await service.maintainPartitions();
          logger.info(outcome, "check_results partitions maintained");
          return;
        }
        const size = kind.slice("rollup-".length) as "5m" | "1h" | "1d";
        const outcome = await rollups.rollup(size);
        logger.info({ size, ...outcome }, "rollup finished");
      },
    }),
  ];
}
