import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import type { AssignedMonitor, CheckResult } from "@app/shared";
import { signRequest, sha256Hex } from "../transport/signer.js";
import { MinHeap } from "../scheduler/min-heap.js";
import { createScheduler, nextSlotMs, stableOffsetMs } from "../scheduler/scheduler.js";
import { createResultBuffer } from "../report/buffer.js";
import { createReporter } from "../report/reporter.js";
import { createExecutor } from "../executor/executor.js";
import { createAddressPolicy } from "../net/address-policy.js";
import { ApiUnavailableError, type ProbeClient } from "../transport/client.js";

const ID = "0190a3b2-7c1d-7e3f-8a9b-0c1d2e3f4a5b";
const silent = pino({ level: "silent" });

function monitor(id: string, intervalSeconds = 60, configSeq = 1): AssignedMonitor {
  return {
    id,
    workspaceId: ID,
    config: { type: "tcp", host: "example.com", port: 80, tls: false },
    intervalSeconds,
    timeoutMs: 5_000,
    configSeq,
  };
}

function result(id: string): CheckResult {
  return {
    id,
    monitorId: ID,
    region: "eu-central",
    checkedAt: new Date().toISOString(),
    ok: true,
    latencyMs: 1,
  };
}

describe("signer", () => {
  it("signs ts, method, path and body hash with HMAC-SHA256", () => {
    const headers = signRequest({
      probeId: ID,
      secret: "s".repeat(32),
      method: "post",
      path: "/api/probe/v1/results",
      body: '{"a":1}',
      nowMs: 1_790_000_000_500,
    });
    const expected = createHmac("sha256", "s".repeat(32))
      .update(`1790000000\nPOST\n/api/probe/v1/results\n${sha256Hex('{"a":1}')}`)
      .digest("hex");
    expect(headers).toEqual({
      "x-probe-id": ID,
      "x-probe-timestamp": "1790000000",
      "x-probe-signature": expected,
    });
  });
});

describe("min-heap", () => {
  it("pops in key order", () => {
    const heap = new MinHeap<string>();
    for (const [k, v] of [
      [5, "e"],
      [1, "a"],
      [3, "c"],
      [2, "b"],
      [4, "d"],
    ] as const)
      heap.push(k, v);
    const out: string[] = [];
    while (heap.size > 0) out.push(heap.pop()?.value ?? "");
    expect(out).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("scheduler", () => {
  it("uses a stable offset per monitor and region", () => {
    expect(stableOffsetMs("m1", "eu-central", 60_000)).toBe(
      stableOffsetMs("m1", "eu-central", 60_000),
    );
    expect(stableOffsetMs("m1", "eu-central", 60_000)).not.toBe(
      stableOffsetMs("m1", "us-east", 60_000),
    );
    expect(nextSlotMs(125_000, 60_000, 10_000)).toBe(130_000);
    expect(nextSlotMs(131_000, 60_000, 10_000)).toBe(190_000);
  });

  it("runs each monitor once per interval and skips a monitor still running", () => {
    let now = 1_000_000;
    const scheduler = createScheduler({ region: "eu-central", now: () => now });
    scheduler.upsert(monitor("a", 60));
    now += 60_000;
    expect(scheduler.due(now).map((m) => m.id)).toEqual(["a"]);
    expect(scheduler.due(now)).toEqual([]);

    scheduler.markRunning("a");
    now += 60_000;
    expect(scheduler.due(now)).toEqual([]);
    scheduler.markDone("a");
    now += 60_000;
    expect(scheduler.due(now).map((m) => m.id)).toEqual(["a"]);
  });

  it("ignores stale updates and stops running removed monitors", () => {
    let now = 0;
    const scheduler = createScheduler({ region: "eu-central", now: () => now });
    scheduler.upsert(monitor("a", 60, 5));
    scheduler.upsert({ ...monitor("a", 15, 3) });
    now += 60_000;
    expect(scheduler.due(now)).toHaveLength(1);
    scheduler.remove("a");
    now += 120_000;
    expect(scheduler.due(now)).toEqual([]);
    expect(scheduler.size()).toBe(0);
  });
});

describe("result buffer", () => {
  it("expires results older than the max age", () => {
    let now = 0;
    const buffer = createResultBuffer({ maxAgeMs: 1_000, now: () => now });
    buffer.push(result("0190a3b2-0000-7000-8000-000000000001"));
    now = 500;
    buffer.push(result("0190a3b2-0000-7000-8000-000000000002"));
    expect(buffer.expire(1_200)).toBe(1);
    expect(buffer.size()).toBe(1);
  });

  it("persists to disk so a restarted private probe keeps unsent results", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "probe-buffer-"));
    try {
      const first = createResultBuffer({ maxAgeMs: 60_000, dir });
      first.push(result("0190a3b2-0000-7000-8000-000000000001"));
      first.push(result("0190a3b2-0000-7000-8000-000000000002"));
      first.ack(new Set(["0190a3b2-0000-7000-8000-000000000001"]));
      const restarted = createResultBuffer({ maxAgeMs: 60_000, dir });
      expect(restarted.peek(10).map((b) => b.result.id)).toEqual([
        "0190a3b2-0000-7000-8000-000000000002",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reporter", () => {
  it("sends in batches, keeps results during an outage and backs off", async () => {
    const batches: number[] = [];
    let up = false;
    let now = 0;
    const client: ProbeClient = {
      request: async (_method, _path, { body }) => {
        if (!up) throw new ApiUnavailableError("down");
        batches.push((body as { results: unknown[] }).results.length);
        return { accepted: 0, duplicates: 0 } as never;
      },
    };
    const buffer = createResultBuffer({ maxAgeMs: 600_000, now: () => now });
    const reporter = createReporter({
      client,
      buffer,
      logger: silent,
      batchSize: 3,
      now: () => now,
    });
    for (let i = 0; i < 7; i += 1) buffer.push(result(`0190a3b2-0000-7000-8000-00000000000${i}`));

    await reporter.flush();
    expect(reporter.stats()).toMatchObject({ buffered: 7, failures: 1 });

    up = true;
    await reporter.flush();
    expect(batches).toEqual([]);
    now += 1_000;
    await reporter.flush();
    expect(batches).toEqual([3, 3, 1]);
    expect(reporter.stats()).toMatchObject({ buffered: 0, sent: 7, dropped: 0 });
  });
});

describe("executor", () => {
  it("caps concurrency and turns crashes and unknown types into probe_error", async () => {
    let active = 0;
    let peak = 0;
    const executor = createExecutor({
      region: "eu-central",
      concurrency: 2,
      policy: createAddressPolicy(),
      runners: {
        tcp: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 30));
          active -= 1;
          return { ok: true, latencyMs: 30 };
        },
        ping: async () => {
          throw new Error("boom");
        },
      },
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => executor.run(monitor(`m${i}`))),
    );
    expect(peak).toBe(2);
    expect(results.every((r) => r.ok && r.region === "eu-central")).toBe(true);
    expect(new Set(results.map((r) => r.id)).size).toBe(6);

    const crashed = await executor.run({
      ...monitor("p"),
      config: { type: "ping", host: "example.com", count: 1, maxLossPercent: 0 },
    });
    expect(crashed).toMatchObject({ ok: false, errorCode: "probe_error" });
    const unknown = await executor.run({
      ...monitor("d"),
      config: { type: "ssl", host: "example.com", port: 443, warnDays: [7] },
    });
    expect(unknown).toMatchObject({ ok: false, errorCode: "probe_error" });
    expect((await executor.run(monitor("t"), ID)).taskId).toBe(ID);
  });

  it("times a request that never got an answer", async () => {
    let clock = 1_000;
    const executor = createExecutor({
      region: "eu-central",
      concurrency: 1,
      policy: createAddressPolicy(),
      now: () => clock,
      runners: {
        tcp: async () => {
          clock += 10_000;
          return { ok: false, errorCode: "connect_timeout", message: "no answer", latencyMs: 0 };
        },
      },
    });
    expect(await executor.run(monitor("slow"))).toMatchObject({ ok: false, latencyMs: 10_000 });
  });
});
