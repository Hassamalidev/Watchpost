/*
 * P1-T10 AC: detection scenarios (§9.2) against the pure engine. Each case gives the monitor, its state
 * and the recent results per region (oldest first here), and checks the decision.
 */
import { describe, expect, it } from "vitest";
import {
  FLAP_STABLE_MS,
  VERIFY_TIMEOUT_MS,
  evaluate,
  type Decision,
  type EngineInput,
  type EngineMonitor,
  type EngineResult,
  type EngineState,
} from "../detection.engine.js";

const T0 = Date.parse("2026-10-01T12:00:00Z");
const at = (seconds: number) => new Date(T0 + seconds * 1_000);
const NOW = 600;

let seq = 0;
const ok = (s: number, latencyMs = 50): EngineResult => ({
  id: `r${(seq += 1)}`,
  ok: true,
  errorCode: null,
  latencyMs,
  checkedAt: at(s),
});
const fail = (s: number, errorCode = "connect_refused"): EngineResult => ({
  id: `r${(seq += 1)}`,
  ok: false,
  errorCode,
  latencyMs: 0,
  checkedAt: at(s),
});

const EU = "eu-central";
const US = "us-east";

interface Scenario {
  name: string;
  monitor?: Partial<EngineMonitor>;
  state?: Partial<EngineState>;
  /* Oldest first, per region. */
  results?: Record<string, EngineResult[]>;
  available?: string[];
  inMaintenance?: boolean;
  now?: number;
  expect: Partial<Decision> & { verifyRegions?: string[] | null; sameRegion?: boolean };
}

function run(s: Omit<Scenario, "name" | "expect">): Decision {
  const monitor: EngineMonitor = {
    regions: [EU],
    minFailingRegions: 2,
    recoverySuccesses: 1,
    degradedAfterChecks: 3,
    upsideDown: false,
    paused: false,
    ...s.monitor,
  };
  const state: EngineState = {
    status: "up",
    since: at(0),
    verifyRequestedAt: null,
    stateChanges: [],
    flappingUntil: null,
    hasOpenIncident: false,
    ...s.state,
  };
  const results: EngineInput["results"] = {};
  for (const [region, list] of Object.entries(s.results ?? {}))
    results[region] = [...list].reverse();
  return evaluate({
    monitor,
    state,
    results,
    availableRegions: s.available ?? monitor.regions,
    inMaintenance: s.inMaintenance ?? false,
    now: at(s.now ?? NOW),
  });
}

const MULTI = { regions: [EU, US], minFailingRegions: 2 };

const scenarios: Scenario[] = [
  {
    name: "pending monitor goes up on its first success",
    state: { status: "pending" },
    results: { [EU]: [ok(590)] },
    expect: { status: "up", openIncident: false, downtime: null },
  },
  {
    name: "pending monitor without results stays pending",
    state: { status: "pending" },
    expect: { status: "pending", verify: null },
  },
  {
    name: "single region: a first failure starts same-region verification",
    results: { [EU]: [ok(500), fail(590)] },
    expect: { status: "verifying", openIncident: false, verifyRegions: [EU], sameRegion: true },
  },
  {
    name: "single region: a confirmed failure opens one incident and an outage",
    state: { status: "verifying", verifyRequestedAt: at(590) },
    results: { [EU]: [ok(500), fail(590), fail(596)] },
    expect: {
      status: "down",
      openIncident: true,
      downtime: "outage",
      transitionAt: at(590),
      causeCode: "connect_refused",
      failingRegions: [EU],
    },
  },
  {
    name: "single region: a failed check followed by a success was transient",
    state: { status: "verifying", verifyRequestedAt: at(590) },
    results: { [EU]: [fail(590), ok(596)] },
    expect: { status: "up", openIncident: false, resolveIncident: false, verifyRequestedAt: null },
  },
  {
    name: "down stays down until enough successes",
    monitor: { recoverySuccesses: 2 },
    state: { status: "down", hasOpenIncident: true },
    results: { [EU]: [fail(500), fail(560), ok(590)] },
    expect: { status: "down", resolveIncident: false, openIncident: false },
  },
  {
    name: "recovery after the required successes resolves the incident",
    monitor: { recoverySuccesses: 2 },
    state: { status: "down", hasOpenIncident: true },
    results: { [EU]: [fail(500), ok(560), ok(590)] },
    expect: { status: "up", resolveIncident: true, downtime: null, transitionAt: at(560) },
  },
  {
    name: "a monitor still failing while down opens no second incident",
    state: { status: "down", since: at(100), hasOpenIncident: true },
    results: { [EU]: [fail(500), fail(590)] },
    expect: { status: "down", openIncident: false, transitionAt: at(100) },
  },
  {
    name: "a down monitor without an incident (manually resolved) gets a new one",
    state: { status: "down", since: at(100), hasOpenIncident: false },
    results: { [EU]: [fail(500), fail(590)] },
    expect: { status: "down", openIncident: true },
  },
  {
    name: "probe errors never count against the customer",
    results: { [EU]: [ok(500), fail(590, "probe_error")] },
    expect: { status: "up", verify: null },
  },
  {
    name: "configuration errors are shown, never paged",
    results: { [EU]: [fail(580, "ssrf_blocked"), fail(590, "ssrf_blocked")] },
    expect: { status: "up", openIncident: false },
  },
  {
    name: "upside down: a success counts as a failure",
    monitor: { upsideDown: true },
    results: { [EU]: [fail(500), ok(590)] },
    expect: { status: "verifying", verifyRegions: [EU] },
  },
  {
    name: "upside down: failures count as success",
    monitor: { upsideDown: true },
    results: { [EU]: [fail(580), fail(590)] },
    expect: { status: "up" },
  },
  {
    name: "upside down: a confirmed success opens an incident",
    monitor: { upsideDown: true },
    state: { status: "verifying", verifyRequestedAt: at(585) },
    results: { [EU]: [ok(580), ok(590)] },
    expect: { status: "down", openIncident: true, causeCode: "upside_down" },
  },
  {
    name: "multi-region: one failing region asks the others to verify",
    monitor: MULTI,
    results: { [EU]: [fail(590)], [US]: [ok(580)] },
    expect: {
      status: "verifying",
      verifyRegions: [US],
      sameRegion: false,
      verifyRequestedAt: at(NOW),
    },
  },
  {
    name: "multi-region: verification answered healthy means a regional issue",
    monitor: MULTI,
    state: { status: "verifying", verifyRequestedAt: at(590) },
    results: { [EU]: [fail(588)], [US]: [ok(595)] },
    expect: {
      status: "degraded",
      reason: "Regional issue: eu-central only",
      openIncident: false,
      downtime: "degraded",
      failingRegions: [EU],
    },
  },
  {
    name: "multi-region: failure confirmed in the required regions opens an incident",
    monitor: MULTI,
    state: { status: "verifying", verifyRequestedAt: at(590) },
    results: { [EU]: [fail(588)], [US]: [fail(595, "connect_timeout")] },
    expect: { status: "down", openIncident: true, failingRegions: [EU, US] },
  },
  {
    name: "multi-region: the outage starts when the required regions were all failing",
    monitor: MULTI,
    state: { status: "degraded", verifyRequestedAt: at(510) },
    results: { [EU]: [fail(500), fail(560)], [US]: [ok(520), fail(590)] },
    expect: { status: "down", transitionAt: at(590) },
  },
  {
    name: "multi-region with minFailingRegions 1 goes down on one region",
    monitor: { regions: [EU, US], minFailingRegions: 1 },
    results: { [EU]: [fail(590)], [US]: [ok(580)] },
    expect: { status: "down", openIncident: true },
  },
  {
    name: "a region without a healthy probe is ignored and the other verifies itself",
    monitor: MULTI,
    available: [EU],
    results: { [EU]: [ok(500), fail(590)], [US]: [fail(560), fail(590)] },
    expect: { status: "verifying", verifyRegions: [EU], sameRegion: true },
  },
  {
    name: "failures from an unavailable region don't count",
    monitor: MULTI,
    available: [EU],
    results: { [EU]: [ok(590)], [US]: [fail(580), fail(590)] },
    expect: { status: "up" },
  },
  {
    name: "a verification with no answer is judged after the timeout",
    monitor: MULTI,
    state: { status: "verifying", verifyRequestedAt: at(NOW - VERIFY_TIMEOUT_MS / 1_000) },
    results: { [EU]: [fail(565)], [US]: [ok(500)] },
    expect: { status: "degraded", openIncident: false },
  },
  {
    name: "a verification still in flight waits",
    monitor: MULTI,
    state: { status: "verifying", verifyRequestedAt: at(595), since: at(595) },
    results: { [EU]: [fail(590)], [US]: [ok(500)] },
    expect: {
      status: "verifying",
      verify: null,
      verifyRequestedAt: at(595),
      transitionAt: at(595),
    },
  },
  {
    name: "slow for N checks in the required regions is degraded",
    monitor: { degradedLatencyMs: 1_000, degradedAfterChecks: 3 },
    results: { [EU]: [ok(560, 1_500), ok(570, 1_600), ok(590, 2_000)] },
    expect: {
      status: "degraded",
      reason: "Slower than the latency threshold",
      openIncident: false,
    },
  },
  {
    name: "slow fewer than N times stays up",
    monitor: { degradedLatencyMs: 1_000, degradedAfterChecks: 3 },
    results: { [EU]: [ok(560, 20), ok(570, 1_600), ok(590, 2_000)] },
    expect: { status: "up" },
  },
  {
    name: "a degraded-impact error code counts as slow, not failure",
    monitor: { degradedLatencyMs: 1_000, degradedAfterChecks: 2 },
    results: { [EU]: [fail(580, "latency_threshold"), fail(590, "latency_threshold")] },
    expect: { status: "degraded", openIncident: false },
  },
  {
    name: "degraded recovers when fast again",
    monitor: { degradedLatencyMs: 1_000, degradedAfterChecks: 3 },
    state: { status: "degraded" },
    results: { [EU]: [ok(570, 2_000), ok(590, 30)] },
    expect: { status: "up", downtime: null },
  },
  {
    name: "a regional issue clears when the region recovers",
    monitor: MULTI,
    state: { status: "degraded", verifyRequestedAt: at(500) },
    results: { [EU]: [fail(550), ok(590)], [US]: [ok(580)] },
    expect: { status: "up", verifyRequestedAt: null },
  },
  {
    name: "recovered but slow resolves the outage into degraded",
    monitor: { degradedLatencyMs: 1_000, degradedAfterChecks: 2 },
    state: { status: "down", hasOpenIncident: true },
    results: { [EU]: [fail(500), ok(580, 3_000), ok(590, 3_000)] },
    expect: { status: "degraded", resolveIncident: true, downtime: "degraded" },
  },
  {
    name: "paused monitors resolve their incident and close the downtime",
    monitor: { paused: true },
    state: { status: "down", hasOpenIncident: true },
    results: { [EU]: [fail(590)] },
    expect: { status: "paused", resolveIncident: true, downtime: null, verify: null },
  },
  {
    name: "a resumed monitor waits for its first result",
    state: { status: "paused" },
    available: [],
    expect: { status: "pending" },
  },
  {
    name: "maintenance records results but opens no incident",
    inMaintenance: true,
    results: { [EU]: [fail(580), fail(590)] },
    expect: { status: "maintenance", openIncident: false, downtime: "maintenance" },
  },
  {
    name: "a region with no data reports unknown",
    monitor: { regions: [EU, US], minFailingRegions: 2 },
    results: { [EU]: [ok(590)] },
    expect: { status: "up", regionStatus: { [EU]: "up", [US]: "unknown" } },
  },
];

describe("detection engine scenarios", () => {
  for (const s of scenarios) {
    it(s.name, () => {
      const decision = run(s);
      const { verifyRegions, sameRegion, ...rest } = s.expect;
      expect(decision).toMatchObject(rest);
      if (verifyRegions !== undefined) {
        expect(decision.verify?.regions ?? null).toEqual(verifyRegions);
      }
      if (sameRegion !== undefined) expect(decision.verify?.sameRegion).toBe(sameRegion);
    });
  }

  it("has at least 25 scenarios", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(25);
  });
});

describe("flapping", () => {
  const changes = (...seconds: number[]) => seconds.map(at);

  it("the fifth change in 30 minutes starts flapping and keeps one incident", () => {
    const d = run({
      state: { status: "up", stateChanges: changes(100, 200, 300, 400) },
      results: { [EU]: [fail(580), fail(590)] },
    });
    expect(d).toMatchObject({ status: "down", flappingStarted: true, openIncident: true });
    expect(d.flappingUntil).toEqual(new Date(at(NOW).getTime() + FLAP_STABLE_MS));
  });

  it("recovering while flapping keeps the incident open", () => {
    const d = run({
      state: {
        status: "down",
        hasOpenIncident: true,
        stateChanges: changes(100, 200, 300, 400, 500),
        flappingUntil: at(NOW + 300),
      },
      results: { [EU]: [fail(500), ok(590)] },
    });
    expect(d).toMatchObject({ status: "up", resolveIncident: false, flappingStarted: false });
    expect(d.flappingUntil).toEqual(new Date(at(NOW).getTime() + FLAP_STABLE_MS));
  });

  it("stable for 15 minutes ends flapping and resolves the incident", () => {
    const d = run({
      now: 2_000,
      state: {
        status: "up",
        hasOpenIncident: true,
        stateChanges: changes(1_000, 1_100),
        flappingUntil: at(1_900),
      },
      results: { [EU]: [ok(1_990)] },
    });
    expect(d).toMatchObject({
      status: "up",
      resolveIncident: true,
      flappingEnded: true,
      flappingUntil: null,
      stateChanges: [],
    });
  });

  it("changes older than 30 minutes don't count", () => {
    const d = run({
      now: 3_000,
      state: { status: "up", stateChanges: changes(100, 200, 300, 400) },
      results: { [EU]: [fail(2_980), fail(2_990)] },
    });
    expect(d).toMatchObject({ status: "down", flappingStarted: false, flappingUntil: null });
    expect(d.stateChanges).toEqual([at(3_000)]);
  });

  it("verifying is not a state change", () => {
    const d = run({ results: { [EU]: [ok(500), fail(590)] } });
    expect(d.status).toBe("verifying");
    expect(d.stateChanges).toEqual([]);
  });
});
