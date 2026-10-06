/*
 * P1-T05 AC with an in-process API stub: the probe registers, syncs, runs checks on schedule and reports
 * them; results produced while the API is down are buffered and delivered after it restarts, with none
 * lost or dropped. Intervals are scaled down (15 s → 150 ms) to keep the test fast.
 */
import { afterEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import type { AssignedMonitor } from "@app/shared";
import { loadProbeConfig } from "../config.js";
import { createProbeRuntime, type ProbeRuntime } from "../runtime.js";
import { createStubApi, type StubApi } from "./helpers/stub-api.js";

const PROBE_ID = "0190a3b2-7c1d-7e3f-8a9b-0c1d2e3f4a5b";
const SECRET = "probe-secret-".padEnd(40, "x");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const monitors: AssignedMonitor[] = [
  {
    id: "0190a3b2-0000-7000-8000-00000000000a",
    workspaceId: PROBE_ID,
    config: { type: "tcp", host: "example.com", port: 80, tls: false },
    intervalSeconds: 15,
    timeoutMs: 5_000,
    configSeq: 1,
  },
  {
    id: "0190a3b2-0000-7000-8000-00000000000b",
    workspaceId: PROBE_ID,
    config: { type: "tcp", host: "example.org", port: 443, tls: false },
    intervalSeconds: 15,
    timeoutMs: 5_000,
    configSeq: 2,
  },
];

let runtime: ProbeRuntime | undefined;
let api: StubApi | undefined;

afterEach(async () => {
  await runtime?.stop({ graceMs: 1_000 });
  await api?.stop();
  runtime = undefined;
  api = undefined;
});

function startProbe(apiUrl: string, secret = SECRET) {
  const config = loadProbeConfig({
    API_URL: apiUrl,
    PROBE_ID,
    PROBE_SECRET: secret,
    PROBE_REGION: "eu-central",
    PROBE_HEALTH_PORT: "0",
  });
  runtime = createProbeRuntime({
    config,
    logger: pino({ level: "silent" }),
    runners: { tcp: async () => ({ ok: true, latencyMs: 3 }) },
    timeScale: 0.01,
    tickMs: 20,
    heartbeatMs: 100,
    syncIntervalMs: 200,
    taskWaitSeconds: 1,
  });
  return runtime;
}

describe("probe runtime", () => {
  it("rejects a probe with the wrong secret at start", async () => {
    api = createStubApi({ probeId: PROBE_ID, secret: SECRET });
    await api.start();
    await expect(startProbe(api.url, "wrong-secret-".padEnd(40, "y")).start()).rejects.toThrow(
      /401/,
    );
    runtime = undefined;
  });

  it("syncs assignments, runs checks on schedule and reports signed batches", async () => {
    api = createStubApi({ probeId: PROBE_ID, secret: SECRET });
    api.monitors = monitors;
    await api.start();
    const probe = startProbe(api.url);
    await probe.start();
    await sleep(1_500);

    const perMonitor = new Map<string, number>();
    for (const r of api.results.values())
      perMonitor.set(r.monitorId, (perMonitor.get(r.monitorId) ?? 0) + 1);
    expect(perMonitor.size).toBe(2);
    for (const count of perMonitor.values()) {
      expect(count).toBeGreaterThanOrEqual(5);
      expect(count).toBeLessThanOrEqual(12);
    }
    expect(api.heartbeats).toBeGreaterThan(0);
    expect(api.rejected).toBe(0);

    const health = await fetch(`http://127.0.0.1:${probe.healthPort()}/healthz`);
    expect(health.status).toBe(200);
  });

  it("loses no results when the API restarts", async () => {
    const stub = createStubApi({ probeId: PROBE_ID, secret: SECRET });
    api = stub;
    stub.monitors = monitors;
    await stub.start();
    const port = stub.port;
    const probe = startProbe(stub.url);
    await probe.start();
    await sleep(500);

    await stub.stop();
    const downFrom = Date.now();
    await sleep(1_500);
    const downUntil = Date.now();
    expect(probe.stats().buffered).toBeGreaterThan(0);

    await stub.start(port);
    const deadline = Date.now() + 15_000;
    while (probe.stats().buffered > 0 && Date.now() < deadline) await sleep(100);

    await probe.stop({ graceMs: 1_000 });
    runtime = undefined;
    const stats = probe.stats();
    expect(stats.buffered).toBe(0);
    expect(stats.dropped).toBe(0);
    expect(stub.results.size).toBe(stats.sent);

    const duringOutage = [...stub.results.values()].filter((r) => {
      const t = Date.parse(r.checkedAt);
      return t >= downFrom && t <= downUntil;
    });
    expect(duringOutage.length).toBeGreaterThanOrEqual(10);
  }, 30_000);
});
