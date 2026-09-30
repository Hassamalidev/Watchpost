/* Shared BullMQ job defaults (STACK.md §5) and deterministic job IDs. */
import type { JobsOptions } from "bullmq";

export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential", delay: 1_000 },
  /* Completed jobs are kept briefly for debugging; failed jobs are never removed automatically. */
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: false,
} as const satisfies JobsOptions;

/*
 * Separator between job ID parts, for example `eval.{monitorId}.{lastResultId}`.
 * Not ":" because BullMQ rejects custom IDs containing ":" unless they have exactly three parts (D-021).
 */
export const JOB_ID_SEPARATOR = ".";

/* Builds a deterministic job ID so enqueueing the same work twice creates one job (rule 9). */
export function buildJobId(...parts: Array<string | number>): string {
  if (parts.length === 0) throw new Error("A job ID needs at least one part");
  for (const part of parts) {
    const text = String(part);
    if (text === "" || text.includes(JOB_ID_SEPARATOR)) {
      throw new Error(`Invalid job ID part "${text}"`);
    }
  }
  return parts.join(JOB_ID_SEPARATOR);
}
