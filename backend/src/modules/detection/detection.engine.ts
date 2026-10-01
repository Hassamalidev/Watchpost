/*
 * The detection decision (PRODUCT.md §9.2) as a pure function: monitor settings, current state and the
 * recent results per region in, a decision out. No I/O, no clock: the runner in detection.service.ts
 * loads the inputs under a row lock and applies the decision in the same transaction.
 */
import { CHECK_ERRORS, type CheckErrorCode, type MonitorStatus } from "@app/shared";
import type { DowntimeKind, RegionStatus } from "./schema/detection.js";

export const FLAP_WINDOW_MS = 30 * 60_000;
export const FLAP_CHANGES = 5;
export const FLAP_STABLE_MS = 15 * 60_000;
/* A verification round that hasn't answered by then is judged on what has arrived. */
export const VERIFY_TIMEOUT_MS = 30_000;
/* Results loaded per region; enough for every policy's streak length. */
export const RESULTS_PER_REGION = 20;

export interface EngineMonitor {
  regions: string[];
  minFailingRegions: number;
  /* Open an incident for a failure confirmed in fewer regions than that (a regional issue). */
  alertOnRegionalIssue: boolean;
  /* Already resolved through effectiveRecoverySuccesses. */
  recoverySuccesses: number;
  degradedLatencyMs?: number | undefined;
  degradedAfterChecks: number;
  upsideDown: boolean;
  paused: boolean;
}

export interface EngineResult {
  id: string;
  ok: boolean;
  errorCode: string | null;
  latencyMs: number;
  checkedAt: Date;
  httpStatus?: number | null;
  message?: string | null;
}

export interface EngineState {
  status: MonitorStatus;
  since: Date;
  verifyRequestedAt: Date | null;
  stateChanges: Date[];
  flappingUntil: Date | null;
  hasOpenIncident: boolean;
}

export interface EngineInput {
  monitor: EngineMonitor;
  state: EngineState;
  /* Newest first, per region. */
  results: Record<string, EngineResult[]>;
  /* Monitor regions with a healthy, unquarantined probe. */
  availableRegions: string[];
  inMaintenance: boolean;
  now: Date;
}

export interface Decision {
  status: MonitorStatus;
  reason: string | null;
  /* When the new status really began (the first result of the streak), for downtimes. */
  transitionAt: Date;
  failingRegions: string[];
  causeCode: string | null;
  /* The newest failing result, kept as incident evidence. */
  evidence: EngineResult | null;
  openIncident: boolean;
  /* Failing in fewer regions than required while the others were verified healthy. */
  regionalIssue: boolean;
  resolveIncident: boolean;
  /* Regions to verify in; "same" means re-check the failing region after a short delay. */
  verify: { regions: string[]; sameRegion: boolean } | null;
  verifyRequestedAt: Date | null;
  downtime: DowntimeKind | null;
  regionStatus: Record<string, RegionStatus>;
  stateChanges: Date[];
  flappingUntil: Date | null;
  flappingStarted: boolean;
  flappingEnded: boolean;
}

type Outcome = "ok" | "fail" | "slow";

interface Classified extends EngineResult {
  outcome: Outcome;
}

/* Maps a raw result to what it means for this monitor; undefined means "doesn't count". */
export function classify(result: EngineResult, monitor: EngineMonitor): Outcome | undefined {
  if (!result.ok) {
    const impact = CHECK_ERRORS[result.errorCode as CheckErrorCode]?.impact ?? "failure";
    /* Our faults and misconfiguration never count against the customer (Appendix B). */
    if (impact === "ours" || impact === "config") return undefined;
    if (impact === "degraded") return "slow";
    return monitor.upsideDown ? "ok" : "fail";
  }
  if (monitor.upsideDown) return "fail";
  if (monitor.degradedLatencyMs !== undefined && result.latencyMs > monitor.degradedLatencyMs) {
    return "slow";
  }
  return "ok";
}

const bad = (s: MonitorStatus) => s === "down" || s === "degraded";
/* Verifying is still "up" for flap counting: a transient blip isn't a state change. */
const good = (s: MonitorStatus) => s === "up" || s === "verifying";

export function evaluate(input: EngineInput): Decision {
  const { monitor, state, now } = input;
  const regions = monitor.regions.filter((r) => input.availableRegions.includes(r));
  /* With a single region there is no second opinion, so it must fail twice (§9.2). */
  const perRegionFailures = regions.length <= 1 ? 2 : 1;
  const required = Math.min(monitor.minFailingRegions, Math.max(1, regions.length));

  const byRegion = new Map<string, Classified[]>();
  for (const region of regions) {
    const list: Classified[] = [];
    for (const r of input.results[region] ?? []) {
      const outcome = classify(r, monitor);
      if (outcome !== undefined) list.push({ ...r, outcome });
    }
    byRegion.set(region, list);
  }

  const streak = (list: Classified[], pred: (o: Outcome) => boolean): number => {
    let n = 0;
    while (n < list.length && pred(list[n]!.outcome)) n += 1;
    return n;
  };
  const failStreak = (region: string) => streak(byRegion.get(region) ?? [], (o) => o === "fail");
  const okStreak = (region: string) => streak(byRegion.get(region) ?? [], (o) => o !== "fail");
  const slowStreak = (region: string) => streak(byRegion.get(region) ?? [], (o) => o === "slow");
  const latest = (region: string) => byRegion.get(region)?.[0];

  const failing = regions.filter((r) => failStreak(r) >= perRegionFailures);
  const failedOnce = regions.filter((r) => latest(r)?.outcome === "fail");
  const slow = regions.filter(
    (r) => monitor.degradedLatencyMs !== undefined && slowStreak(r) >= monitor.degradedAfterChecks,
  );
  const withData = regions.filter((r) => latest(r) !== undefined);

  const regionStatus: Record<string, RegionStatus> = {};
  for (const region of monitor.regions) {
    const last = latest(region);
    regionStatus[region] =
      last === undefined
        ? "unknown"
        : failing.includes(region) || last.outcome === "fail"
          ? "down"
          : slow.includes(region)
            ? "degraded"
            : "up";
  }

  /* The oldest result of a region's current streak: when the new status really began. */
  const streakStart = (list: string[], length: (r: string) => number): Date => {
    let earliest = now;
    for (const region of list) {
      const n = length(region);
      const first = byRegion.get(region)?.[n - 1];
      if (first !== undefined && first.checkedAt < earliest) earliest = first.checkedAt;
    }
    return earliest;
  };

  /* An outage begins when the required number of regions were all failing. */
  const downSince = (list: string[], needed: number): Date => {
    const starts = list
      .map((region) => byRegion.get(region)?.[failStreak(region) - 1]?.checkedAt ?? now)
      .sort((a, b) => a.getTime() - b.getTime());
    return starts[Math.min(needed, starts.length) - 1] ?? now;
  };

  const newestFailure = (): Classified | null => {
    let best: Classified | null = null;
    for (const region of failedOnce) {
      const r = latest(region);
      if (r !== undefined && (best === null || r.checkedAt > best.checkedAt)) best = r;
    }
    return best;
  };

  let status: MonitorStatus = state.status;
  let reason: string | null = null;
  let transitionAt = now;
  let verify: Decision["verify"] = null;
  let verifyRequestedAt = state.verifyRequestedAt;
  let evidence: Classified | null = null;
  /* Failing in some regions while verification found the others healthy. */
  let regionalIssue = false;

  if (monitor.paused) {
    status = "paused";
    verifyRequestedAt = null;
  } else if (input.inMaintenance) {
    status = "maintenance";
    verifyRequestedAt = null;
  } else if (withData.length === 0) {
    /* Nothing to judge: a paused or maintenance monitor coming back waits for its first result. */
    if (state.status === "paused" || state.status === "maintenance") status = "pending";
  } else if (failing.length >= required) {
    status = "down";
    evidence = newestFailure();
    transitionAt = state.status === "down" ? state.since : downSince(failing, required);
    verifyRequestedAt = null;
  } else if (state.status === "down") {
    /* Down stays down until every region with data has `recoverySuccesses` good results. */
    const recovered = withData.every((r) => okStreak(r) >= monitor.recoverySuccesses);
    if (recovered) {
      status = slow.length >= required ? "degraded" : "up";
      transitionAt = streakStart(withData, (r) => okStreak(r));
    }
  } else if (failedOnce.length > 0) {
    const others = regions.filter((r) => !failedOnce.includes(r));
    const requestedAt = verifyRequestedAt;
    const answered =
      requestedAt !== null &&
      others.every((r) => {
        const last = latest(r);
        return last !== undefined && last.checkedAt >= requestedAt;
      });
    const timedOut =
      requestedAt !== null && now.getTime() - requestedAt.getTime() >= VERIFY_TIMEOUT_MS;

    if (requestedAt !== null && others.length > 0 && (answered || timedOut)) {
      /* Verification is done and the other regions are healthy: a regional issue. */
      status = "degraded";
      regionalIssue = true;
      reason = `Regional issue: ${failedOnce.join(", ")} only`;
      evidence = newestFailure();
      transitionAt = state.status === "degraded" ? state.since : now;
    } else {
      status = "verifying";
      transitionAt = state.status === "verifying" ? state.since : now;
      if (requestedAt === null) {
        verifyRequestedAt = now;
        verify =
          others.length > 0
            ? { regions: others, sameRegion: false }
            : { regions: failedOnce, sameRegion: true };
      }
    }
  } else if (slow.length >= required) {
    status = "degraded";
    reason = "Slower than the latency threshold";
    transitionAt =
      state.status === "degraded" ? state.since : streakStart(slow, (r) => slowStreak(r));
    verifyRequestedAt = null;
  } else if (state.status === "degraded") {
    const recovered = withData.every((r) => okStreak(r) >= monitor.recoverySuccesses);
    if (recovered) {
      status = "up";
      transitionAt = now;
    }
    verifyRequestedAt = null;
  } else {
    status = "up";
    verifyRequestedAt = null;
    transitionAt = state.status === "up" ? state.since : now;
  }
  if (status !== "verifying" && status !== "degraded") verifyRequestedAt = null;

  /* Flapping: count changes between good and bad over the last 30 minutes (§9.2). */
  const wasFlapping = state.flappingUntil !== null && state.flappingUntil > now;
  let stateChanges = state.stateChanges.filter(
    (at) => now.getTime() - at.getTime() < FLAP_WINDOW_MS,
  );
  const lastClass = classOf(state.status);
  const nextClass = classOf(status);
  const changed = lastClass !== null && nextClass !== null && lastClass !== nextClass;
  if (changed) stateChanges = [...stateChanges, now];
  let flappingUntil = wasFlapping ? state.flappingUntil : null;
  if (stateChanges.length >= FLAP_CHANGES && changed) {
    flappingUntil = new Date(now.getTime() + FLAP_STABLE_MS);
  }
  const flapping = flappingUntil !== null && flappingUntil > now;
  const flappingStarted = flapping && !wasFlapping;
  const flappingEnded = !flapping && state.flappingUntil !== null;
  if (flappingEnded) stateChanges = [];

  /* Incidents: open when down; while flapping keep the one incident open until stable. */
  const alertRegional = regionalIssue && monitor.alertOnRegionalIssue;
  const openIncident = (status === "down" || alertRegional) && !state.hasOpenIncident;
  /* An alerted regional issue keeps its incident (or the outage's) open until the region recovers. */
  const resolveIncident =
    state.hasOpenIncident &&
    !flapping &&
    (status === "up" || status === "paused" || (status === "degraded" && !alertRegional));

  const downtime: DowntimeKind | null =
    status === "down"
      ? "outage"
      : status === "degraded"
        ? "degraded"
        : status === "maintenance"
          ? "maintenance"
          : null;

  return {
    status,
    reason: status === "down" ? null : reason,
    transitionAt,
    failingRegions: status === "down" ? failing : status === "degraded" ? failedOnce : [],
    causeCode: evidence?.errorCode ?? (evidence ? "upside_down" : null),
    evidence: evidence === null ? null : stripOutcome(evidence),
    openIncident,
    resolveIncident,
    regionalIssue,
    verify,
    verifyRequestedAt,
    downtime,
    regionStatus,
    stateChanges,
    flappingUntil: flapping ? flappingUntil : null,
    flappingStarted,
    flappingEnded,
  };
}

function classOf(status: MonitorStatus): "good" | "bad" | null {
  if (good(status)) return "good";
  if (bad(status)) return "bad";
  return null;
}

function stripOutcome(r: Classified): EngineResult {
  const { outcome: _outcome, ...rest } = r;
  return rest;
}
