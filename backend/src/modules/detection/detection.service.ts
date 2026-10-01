/*
 * Result ingest and evaluation (PRODUCT.md §9.2). Ingest accepts only results for monitors assigned to
 * the reporting probe, stores them idempotently, completes their tasks, then either takes the fast
 * path (healthy results for a healthy monitor) or queues an evaluation. An evaluation locks the
 * monitor's state row, runs the pure engine (detection.engine.ts) and applies its decision in the
 * same transaction: status, incident, downtime, verification tasks and outbox events.
 */
import { effectiveRecoverySuccesses, resultsBatchSchema, type CheckResult } from "@app/shared";
import type { Clock } from "../../core/clock.js";
import { ValidationError } from "../../core/errors.js";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import type { Db, DbOrTx } from "../../infra/db/index.js";
import type { Logger } from "../../infra/logger.js";
import type { Outbox } from "../../infra/outbox/index.js";
import { buildJobId, type EnqueueOptions } from "../../infra/queues/index.js";
import type { AuthenticatedProbe } from "../../middleware/probe-auth.js";
import type { DeploysService } from "../deploys/index.js";
import type { IncidentsService } from "../incidents/index.js";
import type { MonitorForDetection, MonitorsService } from "../monitors/index.js";
import type { ProbesService } from "../probes/index.js";
import type { ResultsService } from "../results/index.js";
import type { DetectionRepository } from "./detection.repository.js";
import {
  classify,
  evaluate,
  RESULTS_PER_REGION,
  type Decision,
  type EngineMonitor,
  type EngineResult,
} from "./detection.engine.js";
import type { MonitorStateRow } from "./schema/detection.js";
import { computeUptime, uptimeDays, type UptimeDay, type UptimeSummary } from "./uptime.js";
import { buildChanges, type ChangeEvent } from "./changes.js";
import { errorBudget, monthOf, type ErrorBudget } from "./slo.js";

/* Same-region verification waits a little so a blip has time to clear (§9.2). */
export const SAME_REGION_VERIFY_DELAY_MS = 5_000;
export const SWEEP_EVERY_MS = 60_000;
const SWEEP_BATCH = 1_000;

export type DetectionJob =
  | { kind: "evaluate"; monitorId: string }
  | { kind: "verify"; monitorId: string; workspaceId: string; regions: string[] }
  | { kind: "sweep" };

export interface MonitorStateView {
  monitorId: string;
  status: MonitorStateRow["status"];
  since: string;
  reason: string | null;
  lastResultAt: string | null;
}

export interface IngestResponse {
  accepted: number;
  duplicates: number;
}

export interface EvaluationOutcome {
  from: MonitorStateRow["status"];
  decision: Decision;
  incidentId: string | null;
}

export interface DetectionService {
  ingest(probe: AuthenticatedProbe, body: unknown): Promise<IngestResponse>;
  /* Evaluates one monitor now; undefined if the monitor no longer exists. */
  evaluateMonitor(monitorId: string): Promise<EvaluationOutcome | undefined>;
  /* Creates verification tasks (the delayed same-region re-check). */
  requestVerification(job: Extract<DetectionJob, { kind: "verify" }>): Promise<string[]>;
  /* Queues evaluations for results no evaluation has seen. Returns how many were queued. */
  sweep(): Promise<number>;
  state(monitorId: string): Promise<MonitorStateRow | undefined>;
  /* Status of every monitor in the workspace that has reported (the status wall). */
  states(scope: WorkspaceScope): Promise<MonitorStateView[]>;
  /* Uptime for a range, from downtimes (§9.9). */
  uptime(
    scope: WorkspaceScope,
    monitorId: string,
    options: { from: Date; to: Date; excludeMaintenance: boolean },
  ): Promise<UptimeSummary>;
  /* System: outage seconds per monitor inside [from, to), most first (digests). */
  downtimeByMonitor(
    workspaceId: string,
    from: Date,
    to: Date,
    limit: number,
  ): Promise<Array<{ monitorId: string; seconds: number }>>;
  /* What changed in the `hours` before `before` (address, certificate, settings, response time). */
  changesBefore(
    scope: WorkspaceScope,
    monitorId: string,
    options: { before: Date; hours: number },
  ): Promise<ChangeEvent[]>;
  /* This month's error budget for a monitor. */
  errorBudget(scope: WorkspaceScope, monitorId: string): Promise<ErrorBudget>;
  /* This month's error budget for every monitor in the workspace, most used first. */
  errorBudgets(
    scope: WorkspaceScope,
  ): Promise<Array<ErrorBudget & { monitorId: string; name: string }>>;
  /* Per-day uptime bars for the last `days` UTC days. */
  uptimeDays(
    scope: WorkspaceScope,
    monitorId: string,
    options: { days: number; excludeMaintenance: boolean },
  ): Promise<UptimeDay[]>;
}

/* Error-budget lists stop here; larger workspaces get reports instead (Phase 5). */
const MAX_BUDGET_MONITORS = 5_000;

export interface DetectionServiceDeps {
  db: Db;
  repository: DetectionRepository;
  monitors: Pick<
    MonitorsService,
    "getForProbes" | "getForDetection" | "get" | "changeTimes" | "list"
  >;
  deploys: Pick<DeploysService, "list">;
  results: Pick<
    ResultsService,
    "ingest" | "recent" | "ipHistory" | "tlsHistory" | "latencyAverage"
  >;
  probes: Pick<ProbesService, "isAssigned" | "completeTasks" | "createTasks" | "healthyRegions">;
  incidents: Pick<
    IncidentsService,
    "openForMonitor" | "resolveForMonitor" | "setFlapping" | "findOpenForMonitor"
  >;
  outbox: Outbox;
  clock: Clock;
  logger: Logger;
  newId: () => string;
  enqueue: (job: DetectionJob, options: EnqueueOptions) => Promise<void>;
  /* Maintenance windows arrive with the maintenance module (P2); nothing is in maintenance until then. */
  inMaintenance?: (monitorId: string, at: Date) => Promise<boolean>;
}

export function engineMonitor(m: MonitorForDetection): EngineMonitor {
  return {
    regions: m.regions,
    minFailingRegions: m.policies.minFailingRegions,
    alertOnRegionalIssue: m.policies.alertOnRegionalIssue ?? false,
    recoverySuccesses: effectiveRecoverySuccesses({
      recoverySuccesses: m.policies.recoverySuccesses,
      intervalSeconds: m.intervalSeconds,
    }),
    degradedLatencyMs: m.policies.degradedLatencyMs,
    degradedAfterChecks: m.policies.degradedAfterChecks,
    upsideDown: m.policies.upsideDown,
    paused: m.paused,
  };
}

export function createDetectionService(deps: DetectionServiceDeps): DetectionService {
  const { repository: repo, clock } = deps;

  const evaluateJob = (monitorId: string, suffix: string) =>
    deps.enqueue({ kind: "evaluate", monitorId }, { jobId: buildJobId("eval", monitorId, suffix) });

  /* After ingest: fast path or a queued evaluation, per monitor. */
  async function afterStored(results: CheckResult[]): Promise<void> {
    const byMonitor = new Map<string, CheckResult[]>();
    for (const r of results) byMonitor.set(r.monitorId, [...(byMonitor.get(r.monitorId) ?? []), r]);
    const monitors = new Map(
      (await deps.monitors.getForDetection([...byMonitor.keys()])).map((m) => [m.id, m]),
    );

    for (const [monitorId, list] of byMonitor) {
      const monitor = monitors.get(monitorId);
      if (monitor === undefined) continue;
      const engine = engineMonitor(monitor);
      const newest = list.reduce((a, b) =>
        Date.parse(b.checkedAt) > Date.parse(a.checkedAt) ? b : a,
      );
      const healthy =
        !monitor.paused && list.every((r) => classify(toEngineResult(r), engine) === "ok");

      const fast = await deps.db.transaction(async (tx) => {
        await repo.noteResult(tx, {
          monitorId,
          workspaceId: monitor.workspaceId,
          lastResultAt: new Date(newest.checkedAt),
        });
        if (!healthy || !(await repo.markEvaluatedIfHealthy(tx, monitorId))) return false;
        await repo.upsertRegionStates(
          tx,
          latestPerRegion(list).map((r) => regionRow(r, "up")),
        );
        return true;
      });
      if (fast) continue;
      try {
        await evaluateJob(monitorId, newest.id);
      } catch (err) {
        /* The results are stored and last_result_at is ahead: the sweep evaluates them later. */
        deps.logger.warn({ err, monitorId }, "evaluate enqueue failed; leaving it to the sweep");
      }
    }
  }

  const service: DetectionService = {
    async ingest(probe, body) {
      const parsed = resultsBatchSchema.safeParse(body);
      if (!parsed.success)
        throw new ValidationError(`Invalid results batch: ${parsed.error.message}`);
      const batch = parsed.data;

      const monitors = new Map(
        (await deps.monitors.getForProbes([...new Set(batch.results.map((r) => r.monitorId))])).map(
          (m) => [m.id, m],
        ),
      );
      /* A probe reports only its own region and only monitors it was assigned. */
      const accepted = batch.results.filter((r) => {
        const monitor = monitors.get(r.monitorId);
        return (
          monitor !== undefined &&
          r.region === probe.region &&
          deps.probes.isAssigned(probe, monitor)
        );
      });
      const refused = batch.results.length - accepted.length;
      if (refused > 0) {
        deps.logger.warn(
          { probeId: probe.id, refused, batchId: batch.batchId },
          "refused results for unassigned monitors",
        );
      }

      const outcome = await deps.results.ingest(
        accepted.map((r) => ({
          ...r,
          workspaceId: monitors.get(r.monitorId)?.workspaceId ?? "",
          probeId: probe.id,
        })),
      );
      const stored = new Set(outcome.insertedIds);
      const newResults = accepted.filter((r) => stored.has(r.id));
      await deps.db.transaction((tx) => deps.probes.completeTasks(tx, probe.id, newResults));
      if (newResults.length > 0) await afterStored(newResults);

      return {
        accepted: outcome.accepted,
        duplicates: outcome.duplicates + refused + outcome.rejected,
      };
    },

    async evaluateMonitor(monitorId) {
      const [monitor] = await deps.monitors.getForDetection([monitorId]);
      if (monitor === undefined) return undefined;
      const engine = engineMonitor(monitor);
      const available = monitor.paused
        ? []
        : await deps.probes.healthyRegions({
            regions: monitor.regions,
            workspaceId: monitor.workspaceId,
          });

      let sameRegionVerify: Extract<DetectionJob, { kind: "verify" }> | undefined;
      const outcome = await deps.db.transaction(async (tx) => {
        await repo.ensureState(tx, monitorId, monitor.workspaceId);
        const state = await repo.lockState(tx, monitorId);
        if (state === undefined) throw new Error(`monitor_state row missing for ${monitorId}`);

        /* Read results after taking the lock, so a later evaluation always sees at least as much. */
        const results: Record<string, EngineResult[]> = {};
        for (const region of available) {
          results[region] = (await deps.results.recent(monitorId, region, RESULTS_PER_REGION)).map(
            (r) => ({
              id: r.id,
              ok: r.ok,
              errorCode: r.errorCode,
              latencyMs: r.latencyMs,
              checkedAt: r.checkedAt,
              httpStatus: r.httpStatus,
              message: r.message,
            }),
          );
        }
        const now = clock.now();
        const open = await deps.incidents.findOpenForMonitor(tx, monitorId);
        const inMaintenance = (await deps.inMaintenance?.(monitorId, now)) ?? false;
        const decision = evaluate({
          monitor: engine,
          state: {
            status: state.status,
            since: state.since,
            verifyRequestedAt: state.verifyRequestedAt,
            stateChanges: state.stateChanges,
            flappingUntil: state.flappingUntil,
            hasOpenIncident: open !== undefined,
          },
          results,
          availableRegions: available,
          inMaintenance,
          now,
        });

        let incidentId = open?.id ?? null;
        if (decision.openIncident) {
          const opened = await deps.incidents.openForMonitor(tx, {
            workspaceId: monitor.workspaceId,
            monitorId,
            /* A regional issue is worth knowing about, not worth waking anyone for. */
            title: decision.regionalIssue
              ? `${monitor.name} is failing from ${decision.failingRegions.join(", ")}`
              : `${monitor.name} is down`,
            severity: decision.regionalIssue ? "low" : monitor.severity,
            causeCode: decision.causeCode,
            failingRegions: decision.failingRegions,
            ...(decision.evidence
              ? {
                  evidence: {
                    resultId: decision.evidence.id,
                    checkedAt: decision.evidence.checkedAt.toISOString(),
                    errorCode: decision.evidence.errorCode,
                    httpStatus: decision.evidence.httpStatus ?? null,
                    message: decision.evidence.message ?? null,
                  },
                }
              : {}),
          });
          incidentId = opened.incident.id;
        }
        if (incidentId !== null && decision.flappingStarted) {
          await deps.incidents.setFlapping(tx, incidentId, true);
        }
        /* Detection resolves only what it opened; manual incidents are closed by people. */
        if (decision.resolveIncident && (open === undefined || open.source === "monitor")) {
          await deps.incidents.resolveForMonitor(tx, { monitorId, auto: true });
          incidentId = null;
        } else if (incidentId !== null && decision.flappingEnded) {
          await deps.incidents.setFlapping(tx, incidentId, false);
        }

        await reconcileDowntime(tx, monitor, decision, incidentId);

        if (decision.verify !== null) {
          if (decision.verify.sameRegion) {
            sameRegionVerify = {
              kind: "verify",
              monitorId,
              workspaceId: monitor.workspaceId,
              regions: decision.verify.regions,
            };
          } else {
            await deps.probes.createTasks(tx, {
              workspaceId: monitor.workspaceId,
              monitorId,
              kind: "verify",
              regions: decision.verify.regions,
            });
          }
        }

        const changed = decision.status !== state.status;
        if (changed) {
          await deps.outbox.emit(
            tx,
            "monitor.state_changed",
            {
              monitorId,
              from: state.status,
              to: decision.status,
              at: decision.transitionAt.toISOString(),
            },
            { workspaceId: monitor.workspaceId },
          );
        }

        await repo.upsertRegionStates(
          tx,
          Object.entries(results).flatMap(([region, list]) => {
            const last = list[0];
            const status = decision.regionStatus[region];
            return last === undefined || status === undefined
              ? []
              : [regionRow({ ...last, monitorId, region }, status)];
          }),
        );
        await repo.updateState(tx, monitorId, {
          status: decision.status,
          since: changed ? decision.transitionAt : state.since,
          reason: decision.reason ?? (changed ? null : state.reason),
          openIncidentId: incidentId,
          lastEvaluatedAt: state.lastResultAt,
          verifyRequestedAt: decision.verifyRequestedAt,
          stateChanges: decision.stateChanges,
          flappingUntil: decision.flappingUntil,
        });
        return { from: state.status, decision, incidentId };
      });

      if (sameRegionVerify !== undefined) {
        await deps.enqueue(sameRegionVerify, {
          jobId: buildJobId("verify", monitorId, Math.floor(clock.now().getTime() / 1_000)),
          delayMs: SAME_REGION_VERIFY_DELAY_MS,
        });
      }
      return outcome;
    },

    async requestVerification(job) {
      return deps.db.transaction((tx) =>
        deps.probes.createTasks(tx, {
          workspaceId: job.workspaceId,
          monitorId: job.monitorId,
          kind: "verify",
          regions: job.regions,
        }),
      );
    },

    async sweep() {
      const pending = await repo.unevaluated(deps.db, SWEEP_BATCH);
      for (const p of pending) {
        await evaluateJob(p.monitorId, `sweep-${p.lastResultAt.getTime()}`);
      }
      return pending.length;
    },

    state: (monitorId) => repo.findState(deps.db, monitorId),

    async states(scope) {
      return (await repo.statesForWorkspace(deps.db, scope)).map((s) => ({
        monitorId: s.monitorId,
        status: s.status,
        since: s.since.toISOString(),
        reason: s.reason,
        lastResultAt: s.lastResultAt?.toISOString() ?? null,
      }));
    },

    async uptime(scope, monitorId, { from, to, excludeMaintenance }) {
      const monitor = await deps.monitors.get(scope, monitorId);
      const spans = await repo.downtimesBetween(deps.db, monitorId, from, to);
      return computeUptime({
        spans,
        from,
        to,
        now: clock.now(),
        since: new Date(monitor.createdAt),
        excludeMaintenance,
      });
    },

    async changesBefore(scope, monitorId, { before, hours }) {
      const monitor = await deps.monitors.get(scope, monitorId);
      const from = new Date(before.getTime() - hours * 3_600_000);
      const hourBefore = new Date(before.getTime() - 3_600_000);
      const [ips, certificates, configChanges, recent, baseline, deploys] = await Promise.all([
        deps.results.ipHistory(monitorId, from, before),
        deps.results.tlsHistory(monitorId, from, before),
        deps.monitors.changeTimes(scope, monitorId, from, before),
        deps.results.latencyAverage(monitorId, hourBefore, before),
        deps.results.latencyAverage(monitorId, from, hourBefore),
        deps.deploys.list(scope, from, before),
      ]);
      return buildChanges({
        before,
        createdAt: new Date(monitor.createdAt),
        ips,
        certificates,
        configChanges,
        latency: { recent, baseline },
        deploys: deploys.map((d) => ({ ...d, deployedAt: new Date(d.deployedAt) })),
      });
    },

    async errorBudget(scope, monitorId) {
      await deps.monitors.get(scope, monitorId);
      const [monitor] = await deps.monitors.getForDetection([monitorId]);
      const now = clock.now();
      const { start } = monthOf(now);
      const [used] = await repo.downtimeByMonitor(
        deps.db,
        scope.workspaceId,
        start,
        now,
        1,
        monitorId,
      );
      return errorBudget({
        target: monitor?.policies.sloTarget ?? 99.9,
        usedSeconds: used?.seconds ?? 0,
        now,
      });
    },

    async errorBudgets(scope) {
      const now = clock.now();
      const { start } = monthOf(now);
      /* Every monitor, a page at a time (bounded so a huge workspace can't stall the request). */
      const all: Array<{ id: string; name: string; type: string }> = [];
      let cursor: string | undefined;
      do {
        const page = await deps.monitors.list(scope, {
          limit: 200,
          ...(cursor === undefined ? {} : { cursor }),
        });
        all.push(...page.data);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined && all.length < MAX_BUDGET_MONITORS);
      const monitors = all.filter((m) => m.type !== "heartbeat");
      const targets = new Map(
        (await deps.monitors.getForDetection(monitors.map((m) => m.id))).map((m) => [
          m.id,
          m.policies.sloTarget ?? 99.9,
        ]),
      );
      const used = new Map(
        (await repo.downtimeByMonitor(deps.db, scope.workspaceId, start, now, 10_000)).map((d) => [
          d.monitorId,
          d.seconds,
        ]),
      );
      return monitors
        .map((m) => ({
          monitorId: m.id,
          name: m.name,
          ...errorBudget({
            target: targets.get(m.id) ?? 99.9,
            usedSeconds: used.get(m.id) ?? 0,
            now,
          }),
        }))
        .sort(
          (a, b) =>
            b.usedSeconds / Math.max(1, b.budgetSeconds) -
            a.usedSeconds / Math.max(1, a.budgetSeconds),
        );
    },

    downtimeByMonitor: (workspaceId, from, to, limit) =>
      repo.downtimeByMonitor(deps.db, workspaceId, from, to, limit),

    async uptimeDays(scope, monitorId, { days, excludeMaintenance }) {
      const monitor = await deps.monitors.get(scope, monitorId);
      const now = clock.now();
      const from = new Date(now.getTime() - (days + 1) * 86_400_000);
      const spans = await repo.downtimesBetween(deps.db, monitorId, from, now);
      return uptimeDays({
        spans,
        days,
        now,
        since: new Date(monitor.createdAt),
        excludeMaintenance,
      });
    },
  };

  /* Keeps exactly one open downtime matching the status; closes it when the status moves on. */
  async function reconcileDowntime(
    tx: DbOrTx,
    monitor: MonitorForDetection,
    decision: Decision,
    incidentId: string | null,
  ): Promise<void> {
    const open = await repo.findOpenDowntime(tx, monitor.id);
    if (open !== undefined && open.kind === decision.downtime) return;
    if (open !== undefined) await repo.closeDowntime(tx, open.id, decision.transitionAt);
    if (decision.downtime !== null) {
      await repo.insertDowntime(tx, {
        id: deps.newId(),
        workspaceId: monitor.workspaceId,
        monitorId: monitor.id,
        kind: decision.downtime,
        startedAt: decision.transitionAt,
        incidentId: decision.downtime === "outage" ? incidentId : null,
      });
    }
  }

  return service;
}

function toEngineResult(r: CheckResult): EngineResult {
  return {
    id: r.id,
    ok: r.ok,
    errorCode: r.errorCode ?? null,
    latencyMs: r.latencyMs,
    checkedAt: new Date(r.checkedAt),
  };
}

function latestPerRegion(list: CheckResult[]) {
  const latest = new Map<string, CheckResult>();
  for (const r of list) {
    const current = latest.get(r.region);
    if (current === undefined || Date.parse(r.checkedAt) > Date.parse(current.checkedAt)) {
      latest.set(r.region, r);
    }
  }
  return [...latest.values()].map((r) => ({
    monitorId: r.monitorId,
    region: r.region,
    checkedAt: new Date(r.checkedAt),
    errorCode: r.errorCode ?? null,
    latencyMs: r.latencyMs,
  }));
}

function regionRow(
  r: {
    monitorId: string;
    region: string;
    checkedAt: Date;
    errorCode: string | null;
    latencyMs: number;
  },
  status: "up" | "down" | "degraded" | "unknown",
) {
  return {
    monitorId: r.monitorId,
    region: r.region,
    status,
    lastResultAt: r.checkedAt,
    lastErrorCode: r.errorCode,
    lastLatencyMs: Math.round(r.latencyMs),
  };
}
