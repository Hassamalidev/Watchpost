/*
 * Producer side: one BullMQ Queue per registry entry. Every job needs a deterministic jobId
 * and carries IDs only; processors reload state from Postgres (PRODUCT.md §7.5).
 */
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { DEFAULT_JOB_OPTIONS } from "./job-options.js";
import type { QueueName } from "./registry.js";

export interface EnqueueOptions {
  jobId: string;
  delayMs?: number;
}

export interface Queues {
  enqueue(queue: QueueName, jobName: string, data: object, options: EnqueueOptions): Promise<void>;
  get(queue: QueueName): Queue;
  close(): Promise<void>;
}

export function createQueues(connection: Redis, options: { prefix?: string } = {}): Queues {
  const queues = new Map<QueueName, Queue>();

  const get = (name: QueueName): Queue => {
    let queue = queues.get(name);
    if (queue === undefined) {
      queue = new Queue(name, {
        connection,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
        ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      });
      queues.set(name, queue);
    }
    return queue;
  };

  return {
    get,
    async enqueue(queue, jobName, data, { jobId, delayMs }) {
      await get(queue).add(jobName, data, {
        jobId,
        ...(delayMs === undefined ? {} : { delay: delayMs }),
      });
    },
    async close() {
      await Promise.all([...queues.values()].map((q) => q.close()));
      queues.clear();
    },
  };
}
