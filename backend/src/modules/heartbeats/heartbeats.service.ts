/*
 * Heartbeat monitors (PRODUCT.md §6.7, §9.7). Pings arrive at `<base>/<token>` (plus `/start`,
 * `/fail`, `/<exit code>`); the token is stored hashed and looked up through a 30-second cache. A
 * success sets the next deadline and recovers a missed or failed heartbeat; `/fail` or a non-zero
 * exit code is down at once; a run longer than its maximum is degraded. The sweeper opens "missed"
 * incidents for heartbeats past deadline plus grace — unless our own ingest may have lost the ping:
 * the API ticks every 10 s, the worker turns stale ticks into platform gaps, and a deadline window
 * that overlaps a gap is moved past the gap instead of alerting.
 */
import { createHash, randomBytes } from "node:crypto";
import { nextExpectedAt, type HeartbeatSchedule, type MonitorConfig } from "@app/shared";
import type { Clock } from "../../core/clock.js";
import { ValidationError } from "../../core/errors.js";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import type { Db, Tx } from "../../infra/db/index.js";
import type { Logger } from "../../infra/logger.js";
import type { Outbox } from "../../infra/outbox/index.js";
import type { IncidentsService } from "../incidents/index.js";
import type { MonitorForDetection, MonitorsService } from "../monitors/index.js";
import type { HeartbeatsRepository, HeartbeatStatePatch } from "./heartbeats.repository.js";
import type {
  HeartbeatStateRow,
  HeartbeatStatus,
  PingKind,
  PlatformGapRow,
} from "./schema/heartbeats.js";

export const TOKEN_CACHE_MS = 30_000;
export const EXCERPT_BYTES = 10 * 1024;
/* A component that hasn't ticked for this long counts as down. */
export const TICK_STALE_MS = 30_000;
const SWEEP_BATCH = 500;
const GAP_LOOKBACK_MS = 2 * 86_400_000;

export type PingSignal =
  { kind: "success"; exitCode?: number } | { kind: "start" } | { kind: "fail"; exitCode?: number };

export interface HeartbeatView {
  monitorId: string;
  status: HeartbeatStatus;
  since: string | null;
  reason: string | null;
  hasToken: boolean;
  lastPingAt: string | null;
  nextExpectedAt: string | null;
  runningSince: string | null;
  pings: Array<{
    at: string;
    kind: PingKind;
    exitCode: number | null;
    durationMs: number | null;
    excerpt: string | null;
  }>;
}

export interface SweepOutcome {
  missed: number;
  suppressed: number;
  tooLong: number;
}

export interface HeartbeatsService {
  /* Creates or replaces the ping token; the URL is shown once. */
  rotateToken(scope: WorkspaceScope, monitorId: string): Promise<{ url: string }>;
  get(scope: WorkspaceScope, monitorId: string): Promise<HeartbeatView>;
  /* Every heartbeat with a ping URL in the workspace, without ping logs. */
  list(scope: WorkspaceScope): Promise<Array<Omit<HeartbeatView, "pings">>>;
  ping(token: string, signal: PingSignal, body?: string): Promise<"ok" | "not_found">;
  sweep(): Promise<SweepOutcome>;
  /* The API process says it is alive (every 10 s). */
  apiTick(): Promise<void>;
  /* The worker records its own tick and turns stale ticks into platform gaps. */
  platformTick(): Promise<void>;
}

interface HeartbeatConfig {
  schedule: HeartbeatSchedule;
  graceSeconds: number;
  maxDurationSeconds: number | null;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const iso = (d: Date | null) => (d === null ? null : d.toISOString());

export function createHeartbeatsService(deps: {
  db: Db;
  repository: HeartbeatsRepository;
  monitors: Pick<MonitorsService, "get" | "getForProbes" | "getForDetection">;
  incidents: Pick<IncidentsService, "openForMonitor" | "resolveForMonitor">;
  outbox: Outbox;
  clock: Clock;
  logger: Logger;
  newId: () => string;
  baseUrl: string;
}): HeartbeatsService {
  const { repository: repo, clock } = deps;
  const tokenCache = new Map<string, { monitorId: string | null; until: number }>();

  function heartbeatConfig(config: MonitorConfig | undefined): HeartbeatConfig | undefined {
    if (config?.type !== "heartbeat") return undefined;
    return {
      schedule: config.schedule,
      graceSeconds: config.graceSeconds,
      maxDurationSeconds: config.maxDurationSeconds ?? null,
    };
  }

  async function monitorsById(ids: string[]) {
    const [detection, probes] = await Promise.all([
      deps.monitors.getForDetection(ids),
      deps.monitors.getForProbes(ids),
    ]);
    const configs = new Map(probes.map((m) => [m.id, heartbeatConfig(m.config)]));
    return new Map(
      detection.flatMap((m) => {
        const config = configs.get(m.id);
        return config === undefined ? [] : [[m.id, { monitor: m, config }] as const];
      }),
    );
  }

  async function lookup(tokenHash: string): Promise<string | null> {
    const now = clock.now().getTime();
    const cached = tokenCache.get(tokenHash);
    if (cached !== undefined && cached.until > now) return cached.monitorId;
    const row = await repo.findByTokenHash(deps.db, tokenHash);
    const monitorId = row?.monitorId ?? null;
    tokenCache.set(tokenHash, { monitorId, until: now + TOKEN_CACHE_MS });
    if (tokenCache.size > 10_000) {
      for (const [key, value] of tokenCache) if (value.until <= now) tokenCache.delete(key);
    }
    return monitorId;
  }

  async function transition(
    tx: Tx,
    state: HeartbeatStateRow,
    monitor: MonitorForDetection,
    to: HeartbeatStatus,
    at: Date,
    reason: string | null,
  ): Promise<HeartbeatStatePatch> {
    if (state.status === to) return reason === null ? {} : { reason };
    await deps.outbox.emit(
      tx,
      "monitor.state_changed",
      { monitorId: monitor.id, from: state.status, to, at: at.toISOString() },
      { workspaceId: monitor.workspaceId },
    );
    return { status: to, since: at, reason };
  }

  async function openIncident(
    tx: Tx,
    monitor: MonitorForDetection,
    title: string,
    causeCode: "heartbeat_missed" | "heartbeat_failed_signal",
    evidence: Record<string, unknown>,
  ) {
    await deps.incidents.openForMonitor(tx, {
      workspaceId: monitor.workspaceId,
      monitorId: monitor.id,
      title,
      severity: monitor.severity,
      causeCode,
      failingRegions: [],
      evidence,
      source: "heartbeat",
    });
  }

  /* The deadline window overlaps a gap in our own ingest: the ping may have been lost on our side. */
  function coveringGap(
    expected: Date,
    graceSeconds: number,
    gaps: PlatformGapRow[],
    now: Date,
  ): PlatformGapRow | undefined {
    const from = expected.getTime() - graceSeconds * 1_000;
    const to = expected.getTime() + graceSeconds * 1_000;
    return gaps.find((g) => g.startedAt.getTime() <= to && (g.endedAt ?? now).getTime() >= from);
  }

  const service: HeartbeatsService = {
    async rotateToken(scope, monitorId) {
      const view = await deps.monitors.get(scope, monitorId);
      const config = heartbeatConfig(view.config);
      if (config === undefined) {
        throw new ValidationError("Only heartbeat monitors have a ping URL.");
      }
      const token = randomBytes(24).toString("base64url");
      const previous = await repo.findState(deps.db, monitorId);
      await repo.upsertToken(deps.db, {
        monitorId,
        workspaceId: scope.workspaceId,
        tokenHash: hashToken(token),
        schedule: config.schedule,
        graceSeconds: config.graceSeconds,
        maxDurationSeconds: config.maxDurationSeconds,
      });
      if (previous !== undefined) tokenCache.delete(previous.tokenHash);
      return { url: `${deps.baseUrl}/${token}` };
    },

    async get(scope, monitorId) {
      await deps.monitors.get(scope, monitorId);
      const state = await repo.findState(deps.db, monitorId);
      const pings = state === undefined ? [] : await repo.pings(deps.db, monitorId, 50);
      return {
        monitorId,
        status: state?.status ?? "pending",
        since: state ? iso(state.since) : null,
        reason: state?.reason ?? null,
        hasToken: state !== undefined,
        lastPingAt: state ? iso(state.lastPingAt) : null,
        nextExpectedAt: state ? iso(state.nextExpectedAt) : null,
        runningSince: state ? iso(state.runningSince) : null,
        pings: pings.map((p) => ({
          at: p.at.toISOString(),
          kind: p.kind,
          exitCode: p.exitCode,
          durationMs: p.durationMs,
          excerpt: p.excerpt,
        })),
      };
    },

    async list(scope) {
      return (await repo.listForWorkspace(deps.db, scope.workspaceId)).map((state) => ({
        monitorId: state.monitorId,
        status: state.status,
        since: iso(state.since),
        reason: state.reason,
        hasToken: true,
        lastPingAt: iso(state.lastPingAt),
        nextExpectedAt: iso(state.nextExpectedAt),
        runningSince: iso(state.runningSince),
      }));
    },

    async ping(token, signal, body) {
      const tokenHash = hashToken(token);
      const monitorId = await lookup(tokenHash);
      if (monitorId === null) return "not_found";
      const found = (await monitorsById([monitorId])).get(monitorId);

      return deps.db.transaction(async (tx) => {
        const state = await repo.findState(tx, monitorId, true);
        if (state === undefined || state.tokenHash !== tokenHash) {
          tokenCache.delete(tokenHash);
          return "not_found";
        }
        if (found === undefined) {
          /* The monitor was deleted (or is no longer a heartbeat): its URL stops working. */
          await repo.deleteState(tx, monitorId);
          tokenCache.delete(tokenHash);
          return "not_found";
        }
        const { monitor, config } = found;
        const now = clock.now();
        const excerpt =
          body === undefined || body === ""
            ? null
            : Buffer.from(body).subarray(0, EXCERPT_BYTES).toString("utf8");
        const durationMs =
          signal.kind !== "start" && state.runningSince !== null
            ? now.getTime() - state.runningSince.getTime()
            : null;
        await repo.insertPing(tx, {
          id: deps.newId(),
          workspaceId: monitor.workspaceId,
          monitorId,
          at: now,
          kind: signal.kind,
          exitCode: signal.kind === "start" ? null : (signal.exitCode ?? null),
          durationMs,
          excerpt,
        });

        const patch: HeartbeatStatePatch = {
          schedule: config.schedule,
          graceSeconds: config.graceSeconds,
          maxDurationSeconds: config.maxDurationSeconds,
        };
        if (monitor.paused) {
          await repo.updateState(tx, monitorId, { ...patch, lastPingAt: now });
          return "ok";
        }

        if (signal.kind === "start") {
          await repo.updateState(tx, monitorId, { ...patch, runningSince: now });
          return "ok";
        }

        const finished: HeartbeatStatePatch = {
          ...patch,
          runningSince: null,
          lastPingAt: now,
          nextExpectedAt: nextExpectedAt(config.schedule, now),
        };
        if (signal.kind === "fail") {
          const exit = signal.exitCode === undefined ? "" : ` (exit code ${signal.exitCode})`;
          Object.assign(
            finished,
            await transition(tx, state, monitor, "down", now, `Job reported a failure${exit}`),
          );
          await openIncident(
            tx,
            monitor,
            `${monitor.name} reported a failure`,
            "heartbeat_failed_signal",
            {
              exitCode: signal.exitCode ?? null,
              excerpt: excerpt?.slice(0, 500) ?? null,
            },
          );
        } else {
          const tooLong =
            config.maxDurationSeconds !== null &&
            durationMs !== null &&
            durationMs > config.maxDurationSeconds * 1_000;
          const reason = tooLong
            ? `The run took ${Math.round((durationMs ?? 0) / 1_000)} s (limit ${config.maxDurationSeconds} s)`
            : null;
          Object.assign(
            finished,
            await transition(tx, state, monitor, tooLong ? "degraded" : "up", now, reason),
          );
          if (state.status === "down") {
            await deps.incidents.resolveForMonitor(tx, {
              monitorId,
              auto: true,
              onlySource: "heartbeat",
            });
          }
        }
        await repo.updateState(tx, monitorId, finished);
        return "ok";
      });
    },

    async sweep() {
      await service.platformTick();
      const now = clock.now();
      const gaps = await repo.gapsSince(deps.db, new Date(now.getTime() - GAP_LOOKBACK_MS));
      const outcome: SweepOutcome = { missed: 0, suppressed: 0, tooLong: 0 };

      await deps.db.transaction(async (tx) => {
        const due = await repo.dueMissed(tx, now, SWEEP_BATCH);
        const monitors = await monitorsById(due.map((d) => d.monitorId));
        for (const state of due) {
          const found = monitors.get(state.monitorId);
          if (found === undefined) {
            await repo.deleteState(tx, state.monitorId);
            continue;
          }
          const { monitor, config } = found;
          if (monitor.paused) continue;

          /*
           * The stored deadline, unless the schedule was edited since the last ping: then judge
           * against the new schedule. (Recomputing always would undo a gap's postponement.)
           */
          const scheduleChanged =
            JSON.stringify(state.schedule) !== JSON.stringify(config.schedule);
          const expected =
            scheduleChanged && state.lastPingAt !== null
              ? nextExpectedAt(config.schedule, state.lastPingAt)
              : (state.nextExpectedAt ?? now);
          if (expected.getTime() + config.graceSeconds * 1_000 > now.getTime()) {
            await repo.updateState(tx, state.monitorId, {
              nextExpectedAt: expected,
              schedule: config.schedule,
              graceSeconds: config.graceSeconds,
            });
            continue;
          }

          const gap = coveringGap(expected, config.graceSeconds, gaps, now);
          if (gap !== undefined) {
            outcome.suppressed += 1;
            deps.logger.info(
              { monitorId: state.monitorId, gapId: gap.id },
              "heartbeat deadline fell in a platform gap; not alerting",
            );
            await repo.updateState(tx, state.monitorId, {
              nextExpectedAt: nextExpectedAt(config.schedule, gap.endedAt ?? now),
              schedule: config.schedule,
              graceSeconds: config.graceSeconds,
            });
            continue;
          }

          outcome.missed += 1;
          const patch = await transition(
            tx,
            state,
            monitor,
            "down",
            now,
            `No ping since ${state.lastPingAt?.toISOString() ?? "the start"}`,
          );
          await repo.updateState(tx, state.monitorId, patch);
          await openIncident(
            tx,
            monitor,
            `${monitor.name} missed a heartbeat`,
            "heartbeat_missed",
            {
              expectedAt: expected.toISOString(),
              graceSeconds: config.graceSeconds,
              lastPingAt: iso(state.lastPingAt),
            },
          );
        }
      });

      await deps.db.transaction(async (tx) => {
        const running = await repo.dueTooLong(tx, now, SWEEP_BATCH);
        const monitors = await monitorsById(running.map((r) => r.monitorId));
        for (const state of running) {
          const found = monitors.get(state.monitorId);
          if (found === undefined || found.monitor.paused) continue;
          outcome.tooLong += 1;
          const patch = await transition(
            tx,
            state,
            found.monitor,
            "degraded",
            now,
            `Running for more than ${state.maxDurationSeconds} s`,
          );
          await repo.updateState(tx, state.monitorId, patch);
        }
      });
      return outcome;
    },

    async apiTick() {
      await repo.setTick(deps.db, "api", clock.now());
    },

    async platformTick() {
      const now = clock.now();
      await deps.db.transaction(async (tx) => {
        await repo.lockPlatformTick(tx);
        const worker = await repo.tick(tx, "worker");
        if (worker !== undefined && now.getTime() - worker.getTime() > TICK_STALE_MS) {
          /* The worker (and so the sweeper) was down: pings may have gone unprocessed. */
          await repo.insertGap(tx, {
            id: deps.newId(),
            reason: "worker",
            startedAt: worker,
            endedAt: now,
          });
        }
        const api = await repo.tick(tx, "api");
        const open = await repo.openGap(tx, "ingest");
        const apiStale = api !== undefined && now.getTime() - api.getTime() > TICK_STALE_MS;
        if (apiStale && open === undefined) {
          await repo.insertGap(tx, {
            id: deps.newId(),
            reason: "ingest",
            startedAt: api,
            endedAt: null,
          });
        } else if (!apiStale && open !== undefined) {
          await repo.closeGap(tx, open.id, now);
        }
        await repo.setTick(tx, "worker", now);
      });
    },
  };
  return service;
}
