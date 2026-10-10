/*
 * Task long-poll (PRODUCT.md §7.6): GET /tasks?wait=25 returns as soon as a verification or
 * "Test now" task arrives. Tasks run at once, outside the schedule, and report with their taskId.
 */
import { z } from "zod";
import {
  tasksResponseSchema,
  type AddressPolicy,
  type CheckResult,
  type ProbeTask,
} from "@app/shared";
import { runDiagnostics } from "../diagnostics/index.js";
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
  /* The probe's address rules; with them it also takes diagnose tasks (P8-T04). */
  policy?: AddressPolicy;
  /* Test hook: what runs a diagnose task. */
  diagnose?: typeof runDiagnostics;
  logger: Logger;
  waitSeconds?: number;
  now?: () => number;
}): TaskLoop {
  const wait = options.waitSeconds ?? 25;
  const now = options.now ?? Date.now;
  let stopped = true;
  let loop: Promise<void> | undefined;

  const policy = options.policy;
  const diagnoseWith = options.diagnose ?? runDiagnostics;
  /* Saying which kinds we run is what makes the API send diagnose tasks at all. */
  const kinds = policy === undefined ? "verify,test" : "verify,test,diagnose";

  async function diagnose(task: ProbeTask, rules: AddressPolicy): Promise<void> {
    try {
      const diagnostics = await diagnoseWith(task.monitor.config, { policy: rules });
      if (diagnostics === undefined) return;
      await options.client.request("POST", "/diagnostics", {
        body: { taskId: task.id, diagnostics },
        schema: z.object({ recorded: z.boolean() }),
        timeoutMs: 10_000,
      });
    } catch (err) {
      /* Diagnostics are an extra: a failure here never touches checks or their results. */
      options.logger.warn({ err: (err as Error).message, taskId: task.id }, "diagnostics failed");
    }
  }

  async function run(): Promise<void> {
    let backoffMs = 1_000;
    while (!stopped) {
      try {
        const { tasks } = await options.client.request(
          "GET",
          `/tasks?wait=${wait}&kinds=${kinds}`,
          {
            schema: tasksResponseSchema,
            timeoutMs: (wait + 10) * 1_000,
          },
        );
        backoffMs = 1_000;
        for (const task of tasks) {
          if (Date.parse(task.deadline) < now()) continue;
          if (task.kind === "diagnose") {
            if (policy !== undefined) void diagnose(task, policy);
            continue;
          }
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
