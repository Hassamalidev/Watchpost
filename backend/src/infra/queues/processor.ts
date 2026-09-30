/*
 * Typed job processors. Job data is validated with Zod at the edge (PRODUCT.md §7.1 rule 7);
 * invalid data fails the job permanently instead of retrying.
 */
import { UnrecoverableError, type Job } from "bullmq";
import type { z } from "zod";
import type { Logger } from "../logger.js";
import type { QueueName } from "./registry.js";

export interface JobContext {
  job: Job;
  logger: Logger;
}

export interface JobProcessor {
  queue: QueueName;
  run(job: Job, logger: Logger): Promise<unknown>;
}

export function defineProcessor<S extends z.ZodType>(definition: {
  queue: QueueName;
  schema: S;
  handle: (data: z.infer<S>, ctx: JobContext) => Promise<unknown>;
}): JobProcessor {
  return {
    queue: definition.queue,
    async run(job, logger) {
      const parsed = definition.schema.safeParse(job.data);
      if (!parsed.success) {
        throw new UnrecoverableError(`Invalid job data: ${parsed.error.message}`);
      }
      return definition.handle(parsed.data, { job, logger });
    },
  };
}

/* Rebuilds jobs from Postgres on start (§7.5, "Rebuilt on start from"). Returns jobs enqueued. */
export interface RecoverySweep {
  name: string;
  run(): Promise<number>;
}
