/*
 * The probe process (PRODUCT.md §7.6): hello → full sync → schedule checks → report results;
 * delta sync every 15 s, task long-poll, heartbeat every 15 s, local /healthz, graceful stop that
 * waits for running checks and flushes (or persists) the result buffer.
 */
import http from "node:http";
import { once } from "node:events";
import {
  helloResponseSchema,
  type CheckResult,
  type HelloResponse,
  PROBE_CAPABILITIES,
} from "@app/shared";
import type { Logger } from "pino";
import { z } from "zod";
import type { ProbeConfig } from "./config.js";
import { createExecutor, type CheckRunners } from "./executor/executor.js";
import { createAddressPolicy } from "./net/address-policy.js";
import { createResultBuffer } from "./report/buffer.js";
import { createReporter } from "./report/reporter.js";
import { createScheduler } from "./scheduler/scheduler.js";
import { createAssignmentSync } from "./sync/assignments.js";
import { createTaskLoop } from "./tasks/tasks.js";
import { ApiRejectedError, createProbeClient } from "./transport/client.js";

export const PROBE_VERSION = "0.1.0";

export interface ProbeRuntimeOptions {
  config: ProbeConfig;
  logger: Logger;
  runners: CheckRunners;
  /* Test hooks. */
  timeScale?: number;
  tickMs?: number;
  heartbeatMs?: number;
  syncIntervalMs?: number;
  taskWaitSeconds?: number;
  fetch?: typeof fetch;
}

export interface ProbeStats {
  assigned: number;
  inFlight: number;
  buffered: number;
  sent: number;
  dropped: number;
  failures: number;
  syncErrors: number;
}

export interface ProbeRuntime {
  start(): Promise<void>;
  stop(options?: { graceMs?: number }): Promise<void>;
  stats(): ProbeStats;
  /* Port of the local health server (0 when disabled). */
  healthPort(): number;
}

export function createProbeRuntime(options: ProbeRuntimeOptions): ProbeRuntime {
  const { config, logger } = options;
  const startedAt = Date.now();
  const client = createProbeClient({
    apiUrl: config.apiUrl,
    probeId: config.probeId,
    secret: config.secret,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const scheduler = createScheduler({
    region: config.region,
    now: Date.now,
    ...(options.timeScale ? { timeScale: options.timeScale } : {}),
  });
  const executor = createExecutor({
    region: config.region,
    concurrency: config.concurrency,
    runners: options.runners,
    policy: createAddressPolicy({
      allowPrivate: config.mode === "private",
      allowCidrs: config.allowCidrs,
      denyHosts: config.denyHosts,
    }),
  });
  const reporter = createReporter({
    client,
    buffer: createResultBuffer({ maxAgeMs: config.bufferMaxAgeMs, dir: config.bufferDir }),
    logger: logger.child({ component: "reporter" }),
  });
  const sync = createAssignmentSync({
    client,
    onUpsert: (m) => scheduler.upsert(m),
    onRemove: (id) => scheduler.remove(id),
  });
  const report = (result: CheckResult) => reporter.add(result);
  const tasks = createTaskLoop({
    client,
    executor,
    report,
    logger: logger.child({ component: "tasks" }),
    ...(options.taskWaitSeconds !== undefined ? { waitSeconds: options.taskWaitSeconds } : {}),
  });

  const timers: NodeJS.Timeout[] = [];
  let health: http.Server | undefined;
  let running = false;
  let errors = 0;

  function tick(): void {
    if (!running) return;
    for (const monitor of scheduler.due(Date.now())) {
      scheduler.markRunning(monitor.id);
      void executor
        .run(monitor)
        .then(report)
        .finally(() => scheduler.markDone(monitor.id));
    }
  }

  async function syncSafely(): Promise<void> {
    try {
      await sync.syncOnce();
    } catch (err) {
      errors += 1;
      logger.warn({ err: (err as Error).message }, "assignment sync failed");
    }
  }

  async function heartbeat(): Promise<void> {
    try {
      await client.request("POST", "/heartbeat", {
        body: {
          version: PROBE_VERSION,
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1_000),
          assigned: scheduler.size(),
          inFlight: executor.inFlight(),
          queueDepth: 0,
          bufferedResults: reporter.stats().buffered,
          errors: { sync: errors, upload: reporter.stats().failures },
        },
        schema: z.unknown(),
      });
    } catch (err) {
      logger.debug({ err: (err as Error).message }, "heartbeat failed");
    }
  }

  async function hello(): Promise<HelloResponse> {
    let delayMs = 1_000;
    for (;;) {
      try {
        return await client.request("POST", "/hello", {
          body: {
            version: PROBE_VERSION,
            mode: config.mode,
            region: config.region,
            capabilities: [...PROBE_CAPABILITIES],
          },
          schema: helloResponseSchema,
        });
      } catch (err) {
        if (err instanceof ApiRejectedError) throw err;
        logger.warn(
          { err: (err as Error).message, retryInMs: delayMs },
          "API unreachable at start; retrying",
        );
        await new Promise((r) => setTimeout(r, delayMs));
        delayMs = Math.min(30_000, delayMs * 2);
      }
    }
  }

  const stats = (): ProbeStats => ({
    assigned: scheduler.size(),
    inFlight: executor.inFlight(),
    ...reporter.stats(),
    syncErrors: errors,
  });

  return {
    stats,
    healthPort: () => {
      const address = health?.address();
      return address && typeof address === "object" ? address.port : 0;
    },

    async start() {
      const greeting = await hello();
      logger.info(
        { probeId: greeting.probeId, region: config.region, mode: config.mode },
        "probe registered",
      );
      running = true;
      await syncSafely();
      reporter.start();
      tasks.start();
      timers.push(setInterval(tick, options.tickMs ?? 250));
      timers.push(
        setInterval(() => void syncSafely(), options.syncIntervalMs ?? greeting.syncIntervalMs),
      );
      timers.push(setInterval(() => void heartbeat(), options.heartbeatMs ?? 15_000));
      void heartbeat();

      if (config.healthPort > 0 || options.tickMs !== undefined) {
        health = http.createServer((req, res) => {
          const ok = req.url === "/healthz" && running;
          res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok, ...stats() }));
        });
        health.listen(options.tickMs !== undefined ? 0 : config.healthPort);
        await once(health, "listening");
      }
    },

    async stop({ graceMs = 20_000 } = {}) {
      running = false;
      for (const t of timers) clearInterval(t);
      await tasks.stop();
      await Promise.race([executor.idle(), new Promise((r) => setTimeout(r, graceMs))]);
      await reporter.stop();
      await reporter.flush();
      if (health) await new Promise((r) => health?.close(r));
      logger.info(stats(), "probe stopped");
    },
  };
}
