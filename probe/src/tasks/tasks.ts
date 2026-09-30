/*
 * Task long-poll (PRODUCT.md §7.6): GET /tasks?wait=25 returns as soon as a verification or
 * "Test now" task arrives. Tasks run at once, outside the schedule, and report with their taskId.
 */
import { tasksResponseSchema, type CheckResult } from "@app/shared";
import type { Logger } from "pino";
import type { Executor } from "../executor/executor.js";
import type { ProbeClient } from "../transport/client.js";

export interface TaskLoop {
  start(): void;
  stop(): Promise<void>;
}

export function createTaskLoop(options: {
  client: ProbeClient;
  executor: Executor;
  report: (result: CheckResult) => void;
  logger: Logger;
  waitSeconds?: number;
  now?: () => number;
}): TaskLoop {
  const wait = options.waitSeconds ?? 25;
  const now = options.now ?? Date.now;
  let stopped = true;
  let loop: Promise<void> | undefined;

  async function run(): Promise<void> {
    let backoffMs = 1_000;
    while (!stopped) {
      try {
        const { tasks } = await options.client.request("GET", `/tasks?wait=${wait}`, {
          schema: tasksResponseSchema,
          timeoutMs: (wait + 10) * 1_000,
        });
        backoffMs = 1_000;
        for (const task of tasks) {
          if (Date.parse(task.deadline) < now()) continue;
          void options.executor.run(task.monitor, task.id).then(options.report);
        }
      } catch (err) {
        if (stopped) return;
        options.logger.warn({ err: (err as Error).message, backoffMs }, "task poll failed");
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(30_000, backoffMs * 2);
      }
    }
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      loop = run();
    },
    async stop() {
      stopped = true;
      /* An in-flight long-poll ends on its own timeout; don't block shutdown on it. */
      await Promise.race([loop, new Promise((r) => setTimeout(r, 100))]);
    },
  };
}
