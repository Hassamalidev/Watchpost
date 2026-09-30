/* BullMQ processors for the results module: partition maintenance on the `results` queue. */
import { z } from "zod";
import { defineProcessor, type JobProcessor } from "../../../infra/queues/index.js";
import type { ResultsService } from "../results.service.js";

export const PARTITION_JOB_EVERY_MS = 3_600_000;

export function createResultsProcessors(service: ResultsService): JobProcessor[] {
  return [
    defineProcessor({
      queue: "results",
      schema: z.object({ kind: z.enum(["partitions"]) }),
      async handle(_data, { logger }) {
        const outcome = await service.maintainPartitions();
        logger.info(outcome, "check_results partitions maintained");
      },
    }),
  ];
}
