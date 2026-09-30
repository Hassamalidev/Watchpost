/* Worker runtime against real Redis, isolated with a unique BullMQ prefix per run. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pino } from "pino";
import type { Redis } from "ioredis";
import {
  buildJobId,
  createQueueConnection,
  createQueues,
  createWorkerRuntime,
  defineProcessor,
  installShutdownHandlers,
  type JobProcessor,
  type Queues,
  type WorkerRuntime,
} from "../index.js";
import { TEST_REDIS_URL } from "../../../__tests__/helpers/test-env.js";

const prefix = `test-${randomUUID()}`;
const logger = pino({ level: "silent" });
let connection: Redis;
let queues: Queues;
const runtimes: WorkerRuntime[] = [];

function startRuntime(
  processors: JobProcessor[],
  extra: Partial<Parameters<typeof createWorkerRuntime>[0]> = {},
) {
  const runtime = createWorkerRuntime({ connection, logger, processors, prefix, ...extra });
  runtimes.push(runtime);
  return runtime;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await sleep(25);
  }
}

beforeAll(() => {
  connection = createQueueConnection(TEST_REDIS_URL);
  queues = createQueues(connection, { prefix });
});

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.stop()));
});

afterAll(async () => {
  for (const name of ["evaluate", "timers", "notify"] as const) {
    await queues.get(name).obliterate({ force: true });
  }
  await queues.close();
  await connection.quit();
});

const evaluateData = z.object({ monitorId: z.string() });

describe("worker runtime", () => {
  it("runs a test job with validated data", async () => {
    const seen = deferred<string>();
    const runtime = startRuntime([
      defineProcessor({
        queue: "evaluate",
        schema: evaluateData,
        handle: async (data) => seen.resolve(data.monitorId),
      }),
    ]);
    await runtime.start();
    await queues.enqueue(
      "evaluate",
      "evaluate",
      { monitorId: "m-1" },
      { jobId: buildJobId("eval", "m-1", 1) },
    );
    await expect(seen.promise).resolves.toBe("m-1");
  });

  it("runs a job once when the same jobId is enqueued twice", async () => {
    let runs = 0;
    const runtime = startRuntime([
      defineProcessor({
        queue: "evaluate",
        schema: evaluateData,
        handle: async () => {
          runs += 1;
          await sleep(100);
        },
      }),
    ]);
    const jobId = buildJobId("eval", "m-dup", 7);
    await queues.enqueue("evaluate", "evaluate", { monitorId: "m-dup" }, { jobId });
    await queues.enqueue("evaluate", "evaluate", { monitorId: "m-dup" }, { jobId });
    await runtime.start();
    await waitFor(async () => (await queues.get("evaluate").getJobState(jobId)) === "completed");
    expect(runs).toBe(1);
  });

  it("fails invalid job data permanently and keeps the failed job", async () => {
    let runs = 0;
    const runtime = startRuntime([
      defineProcessor({
        queue: "evaluate",
        schema: evaluateData,
        handle: async () => {
          runs += 1;
        },
      }),
    ]);
    await runtime.start();
    const jobId = buildJobId("eval", "bad", 1);
    await queues.enqueue("evaluate", "evaluate", { wrong: true }, { jobId });
    await waitFor(async () => (await queues.get("evaluate").getJobState(jobId)) === "failed");
    const job = await queues.get("evaluate").getJob(jobId);
    expect(job?.attemptsMade).toBe(1);
    expect(job?.failedReason).toContain("Invalid job data");
    expect(runs).toBe(0);
  });

  it("retries a failing job with backoff", async () => {
    let attempts = 0;
    const runtime = startRuntime([
      defineProcessor({
        queue: "notify",
        schema: z.object({}),
        handle: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("provider hiccup");
        },
      }),
    ]);
    await runtime.start();
    const jobId = buildJobId("notify", "e1", "d1");
    await queues.enqueue("notify", "notify", {}, { jobId });
    await waitFor(async () => (await queues.get("notify").getJobState(jobId)) === "completed");
    expect(attempts).toBe(2);
  });

  it("runs recovery sweeps on start, and a failing sweep does not block start", async () => {
    const ran: string[] = [];
    const runtime = startRuntime([], {
      recoverySweeps: [
        {
          name: "broken",
          run: async () => {
            throw new Error("db down");
          },
        },
        {
          name: "evaluate",
          run: async () => {
            ran.push("evaluate");
            return 0;
          },
        },
      ],
    });
    await runtime.start();
    expect(ran).toEqual(["evaluate"]);
  });

  it("consumes only the queues listed in onlyQueues", () => {
    const noop = (queue: "evaluate" | "timers") =>
      defineProcessor({ queue, schema: z.unknown(), handle: async () => {} });
    const runtime = startRuntime([noop("evaluate"), noop("timers")], { onlyQueues: ["timers"] });
    expect(runtime.queues).toEqual(["timers"]);
  });

  it("rejects two processors for one queue", () => {
    const p = defineProcessor({ queue: "evaluate", schema: z.unknown(), handle: async () => {} });
    expect(() => startRuntime([p, p])).toThrow(/Two processors/);
  });
});

describe("graceful shutdown", () => {
  it("stop() waits for the active job to finish", async () => {
    const active = deferred();
    let finished = false;
    const runtime = startRuntime([
      defineProcessor({
        queue: "timers",
        schema: z.object({}),
        handle: async () => {
          active.resolve();
          await sleep(500);
          finished = true;
        },
      }),
    ]);
    await runtime.start();
    await queues.enqueue("timers", "timer", {}, { jobId: buildJobId("timer", "snooze", "i1", 1) });
    await active.promise;
    expect(finished).toBe(false);
    await runtime.stop();
    expect(finished).toBe(true);
  });

  it("SIGTERM stops gracefully, then exits 0", async () => {
    const active = deferred();
    const exited = deferred<number>();
    let finished = false;
    const runtime = startRuntime([
      defineProcessor({
        queue: "timers",
        schema: z.object({}),
        handle: async () => {
          active.resolve();
          await sleep(300);
          finished = true;
        },
      }),
    ]);
    const signals = new EventEmitter();
    installShutdownHandlers(() => runtime.stop(), {
      logger,
      signals,
      exit: (code) => exited.resolve(code),
    });
    await runtime.start();
    await queues.enqueue("timers", "timer", {}, { jobId: buildJobId("timer", "snooze", "i2", 1) });
    await active.promise;
    signals.emit("SIGTERM", "SIGTERM");
    await expect(exited.promise).resolves.toBe(0);
    expect(finished).toBe(true);
  });
});
