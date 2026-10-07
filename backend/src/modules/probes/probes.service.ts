/*
 * Probe registry, assignments and tasks (PRODUCT.md §7.6). Assignments come from the monitors change
 * feed filtered to what a probe may run; tasks (verification, "Test now") are claimed atomically and
 * delivered through the long-poll, woken by NOTIFY.
 */
import { randomBytes } from "node:crypto";
import {
  LAUNCH_REGIONS,
  PROBE_MONITOR_TYPES,
  type AssignedMonitor,
  type AssignmentsResponse,
  type CheckResult,
  type HelloRequest,
  type HelloResponse,
  type ProbeHeartbeat,
  type ProbeTask,
  type Region,
} from "@app/shared";
import type { Clock } from "../../core/clock.js";
import { NotFoundError, ValidationError } from "../../core/errors.js";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import type { TokenCipher } from "../../infra/crypto.js";
import type { Db, DbOrTx } from "../../infra/db/index.js";
import type { AuthenticatedProbe } from "../../middleware/probe-auth.js";
import type { MonitorForProbe, MonitorsService } from "../monitors/index.js";
import type { ResultsService } from "../results/index.js";
import {
  GUARD_BASELINE_MS,
  GUARD_MIN_MONITORS,
  GUARD_MIN_RATIO,
  GUARD_WINDOW_MS,
  QUARANTINE_MS,
  SERVED_WINDOW_MS,
  SILENT_AFTER_MS,
  batchLooksBroken,
  overThreshold,
  type GuardStats,
} from "./guard.js";
import type { ProbesRepository } from "./probes.repository.js";
import type { ProbeRow } from "./schema/probes.js";
import type { TaskNotifier } from "./types/task-notifier.js";

export const SYNC_INTERVAL_MS = 15_000;
export const TASK_TTL_MS = 60_000;
export const VERIFY_WINDOW_MS = 30_000;
/* A probe not seen for this long is unhealthy: its region stops counting (§9.2). */
export const PROBE_HEALTHY_MS = 60_000;
/* Stands for "no workspace": only our own probes count, never a customer's private one. */
const NO_WORKSPACE = "00000000-0000-0000-0000-000000000000";
const PAGE = 1_000;
const AUTH_CACHE_MS = 30_000;

export interface ProbeTaskView {
  id: string;
  region: string;
  kind: "verify" | "test";
  status: "pending" | "running" | "completed" | "expired";
  result: Record<string, unknown> | null;
}

export interface ProbesService {
  register(input: {
    name: string;
    region: Region;
    kind: "managed" | "private";
    workspaceId?: string;
  }): Promise<{ id: string; secret: string }>;
  authLookup(probeId: string): Promise<{ probe: AuthenticatedProbe; secret: string } | undefined>;
  hello(probe: AuthenticatedProbe, body: HelloRequest): Promise<HelloResponse>;
  heartbeat(probe: AuthenticatedProbe, body: ProbeHeartbeat): Promise<void>;
  assignments(
    probe: AuthenticatedProbe,
    after: number,
    full: boolean,
  ): Promise<AssignmentsResponse>;
  /* True if this probe may run this monitor. */
  isAssigned(probe: AuthenticatedProbe, monitor: MonitorForProbe): boolean;
  createTasks(
    tx: DbOrTx,
    input: { workspaceId: string; monitorId: string; kind: "verify" | "test"; regions: string[] },
  ): Promise<string[]>;
  testNow(scope: WorkspaceScope, monitorId: string): Promise<ProbeTaskView[]>;
  getTask(scope: WorkspaceScope, taskId: string): Promise<ProbeTaskView>;
  pollTasks(probe: AuthenticatedProbe, waitSeconds: number): Promise<ProbeTask[]>;
  completeTasks(tx: DbOrTx, probeId: string, results: CheckResult[]): Promise<void>;
  /* Of `regions`, those with a healthy probe that may run this workspace's monitors. */
  healthyRegions(input: { regions: string[]; workspaceId: string }): Promise<string[]>;
  /*
   * Probe health guard (§9.2). Called for each batch once it is stored and before it is evaluated:
   * quarantines the probe when the batch, or its last five minutes, fail far more than usual.
   * True if this call quarantined it (or renewed its quarantine).
   */
  guard(probe: AuthenticatedProbe, batch: { monitors: number; failing: number }): Promise<boolean>;
  /* Re-checks every managed probe: renews quarantines that still hold, reports silent probes. */
  guardSweep(): Promise<string[]>;
  /* Regions we check from: those with a probe of ours that reported in the last day. */
  servedRegions(): Promise<string[]>;
  /* Each region we check from, and whether a probe of ours there is reporting and trusted now. */
  regionHealth(): Promise<Array<{ region: string; healthy: boolean }>>;
  /* System (/api/ready warning): throws naming the regions without a healthy probe of ours. */
  regionsCovered(): Promise<void>;
  close(): Promise<void>;
}

export interface QuarantineInfo extends GuardStats {
  probeId: string;
  region: string;
  /* `batch`: one batch failed nearly everything; `window`: the five-minute rule. */
  reason: "batch" | "window";
}

export interface SilentProbeInfo {
  probeId: string;
  name: string;
  region: string;
  lastSeenAt: Date | null;
}

function toAssigned(m: MonitorForProbe): AssignedMonitor {
  return {
    id: m.id,
    workspaceId: m.workspaceId,
    config: m.config,
    intervalSeconds: m.intervalSeconds,
    timeoutMs: m.timeoutMs,
    configSeq: m.configSeq,
  };
}

function toAuthenticated(row: ProbeRow): AuthenticatedProbe {
  return { id: row.id, region: row.region, kind: row.kind, workspaceId: row.workspaceId };
}

export function createProbesService(deps: {
  db: Db;
  repository: ProbesRepository;
  monitors: MonitorsService;
  cipher: TokenCipher;
  clock: Clock;
  newId: () => string;
  notifier: TaskNotifier;
  /* The guard reads how each probe's checks are going; without it the guard is off. */
  results?: Pick<ResultsService, "probeFailureStats" | "probeFailureRatio"> | undefined;
  /* Told once when a quarantine starts. */
  onQuarantine?: ((info: QuarantineInfo) => Promise<void>) | undefined;
  /* Told on every sweep while a probe of ours isn't reporting. */
  onSilent?: ((info: SilentProbeInfo) => Promise<void>) | undefined;
}): ProbesService {
  const { repository: repo, clock } = deps;
  const authCache = new Map<
    string,
    { value: { probe: AuthenticatedProbe; secret: string }; until: number }
  >();
  /* Tasks are announced per region; private probes wake too and claim only their workspace's tasks. */
  const notifyKeyFor = (probe: { region: string }) => probe.region;

  async function quarantineNow(
    probe: { id: string; region: string },
    reason: QuarantineInfo["reason"],
    stats: GuardStats,
    now: Date,
  ): Promise<void> {
    const fresh = await repo.quarantine(probe.id, new Date(now.getTime() + QUARANTINE_MS), now);
    if (fresh) {
      await deps.onQuarantine?.({ probeId: probe.id, region: probe.region, reason, ...stats });
    }
  }

  /* The five-minute rule for one probe: its numbers when it is over the line, otherwise null. */
  async function overWindow(probeId: string, now: Date): Promise<GuardStats | null> {
    const { results } = deps;
    if (results === undefined) return null;
    const windowStart = new Date(now.getTime() - GUARD_WINDOW_MS);
    const window = await results.probeFailureStats(probeId, windowStart);
    /* The baseline reads a day of results: only for a probe already over the 30% floor. */
    if (window.monitors < GUARD_MIN_MONITORS) return null;
    if (window.failing / window.monitors <= GUARD_MIN_RATIO) return null;
    const stats: GuardStats = {
      ...window,
      baselineRatio: await results.probeFailureRatio(
        probeId,
        new Date(windowStart.getTime() - GUARD_BASELINE_MS),
        windowStart,
      ),
    };
    return overThreshold(stats) ? stats : null;
  }

  const isAssigned = (probe: AuthenticatedProbe, m: MonitorForProbe) =>
    !m.paused &&
    PROBE_MONITOR_TYPES.includes(m.config.type) &&
    m.regions.includes(probe.region) &&
    (probe.kind === "managed" || m.workspaceId === probe.workspaceId);

  const view = (row: {
    id: string;
    region: string;
    kind: "verify" | "test";
    claimedBy: string | null;
    completedAt: Date | null;
    expiresAt: Date;
    result: Record<string, unknown> | null;
  }): ProbeTaskView => ({
    id: row.id,
    region: row.region,
    kind: row.kind,
    status: row.completedAt
      ? "completed"
      : row.expiresAt.getTime() < clock.now().getTime()
        ? "expired"
        : row.claimedBy
          ? "running"
          : "pending",
    result: row.result,
  });

  const service: ProbesService = {
    async register(input) {
      const id = deps.newId();
      const secret = randomBytes(32).toString("base64url");
      await repo.insertProbe({
        id,
        name: input.name,
        region: input.region,
        kind: input.kind,
        workspaceId: input.workspaceId ?? null,
        secretEnc: deps.cipher.encrypt(secret, `probe:${id}`),
      });
      return { id, secret };
    },

    async authLookup(probeId) {
      const cached = authCache.get(probeId);
      if (cached && cached.until > Date.now()) return cached.value;
      const row = await repo.findProbe(probeId);
      if (row === undefined || row.disabled) return undefined;
      const value = {
        probe: toAuthenticated(row),
        secret: deps.cipher.decrypt(row.secretEnc, `probe:${row.id}`),
      };
      authCache.set(probeId, { value, until: Date.now() + AUTH_CACHE_MS });
      return value;
    },

    async hello(probe, body) {
      if (body.region !== probe.region || body.mode !== probe.kind) {
        throw new ValidationError(
          `This probe is registered as ${probe.kind} in ${probe.region}, not ${body.mode} in ${body.region}.`,
        );
      }
      await repo.touch(probe.id, { version: body.version });
      return {
        probeId: probe.id,
        serverTime: clock.now().toISOString(),
        syncIntervalMs: SYNC_INTERVAL_MS,
        batch: { maxResults: 100, maxWaitMs: 1_000 },
      };
    },

    async heartbeat(probe, body) {
      await repo.touch(probe.id, {
        version: body.version,
        lastHeartbeat: body as unknown as Record<string, unknown>,
      });
    },

    isAssigned,

    async assignments(probe, after, full) {
      await repo.touch(probe.id, {});
      if (full || after === 0) {
        const cursor = await deps.monitors.latestSeq();
        const upserts: AssignedMonitor[] = [];
        let afterId: string | null = null;
        do {
          const page = await deps.monitors.listForProbes({
            limit: PAGE,
            ...(afterId === null ? {} : { afterId }),
          });
          for (const m of page.monitors) if (isAssigned(probe, m)) upserts.push(toAssigned(m));
          afterId = page.nextAfterId;
        } while (afterId !== null);
        return { cursor, full: true, upserts, deletes: [] };
      }
      const feed = await deps.monitors.changesSince(after, PAGE);
      const upserts: AssignedMonitor[] = [];
      const deletes = new Set(feed.deletes);
      for (const m of feed.upserts) {
        if (isAssigned(probe, m)) upserts.push(toAssigned(m));
        else deletes.add(m.id);
      }
      return { cursor: feed.cursor, full: false, upserts, deletes: [...deletes] };
    },

    async createTasks(tx, input) {
      const now = clock.now().getTime();
      const ids: string[] = [];
      for (const region of input.regions) {
        const id = deps.newId();
        const dedupeKey =
          input.kind === "verify"
            ? `verify:${input.monitorId}:${region}:${Math.floor(now / VERIFY_WINDOW_MS)}`
            : `test:${id}`;
        const created = await repo.insertTask(
          tx,
          {
            id,
            workspaceId: input.workspaceId,
            monitorId: input.monitorId,
            region,
            kind: input.kind,
            dedupeKey,
            expiresAt: new Date(now + TASK_TTL_MS),
          },
          region,
        );
        if (created) ids.push(created.id);
      }
      return ids;
    },

    async guard(probe, batch) {
      /* Only our own probes: a private probe sits in the customer's network, which may be down. */
      if (probe.kind !== "managed" || deps.results === undefined) return false;
      if (batch.failing === 0) return false;
      const now = clock.now();
      if (batchLooksBroken(batch)) {
        await quarantineNow(probe, "batch", { ...batch, baselineRatio: 0 }, now);
        return true;
      }
      const stats = await overWindow(probe.id, now);
      if (stats === null) return false;
      await quarantineNow(probe, "window", stats, now);
      return true;
    },

    async guardSweep() {
      const now = clock.now();
      const quarantined: string[] = [];
      const recent = await repo.managedProbes(new Date(now.getTime() - SERVED_WINDOW_MS));
      for (const probe of recent) {
        const silentFor = now.getTime() - (probe.lastSeenAt?.getTime() ?? 0);
        if (silentFor > SILENT_AFTER_MS) {
          await deps.onSilent?.({
            probeId: probe.id,
            name: probe.name,
            region: probe.region,
            lastSeenAt: probe.lastSeenAt,
          });
          continue;
        }
        const stats = await overWindow(probe.id, now);
        if (stats === null) continue;
        await quarantineNow(probe, "window", stats, now);
        quarantined.push(probe.id);
      }
      return quarantined;
    },

    async servedRegions() {
      const since = new Date(clock.now().getTime() - SERVED_WINDOW_MS);
      return [...new Set((await repo.managedProbes(since)).map((probe) => probe.region))];
    },

    async regionHealth() {
      const served = await service.servedRegions();
      const healthy = new Set(
        await service.healthyRegions({ regions: served, workspaceId: NO_WORKSPACE }),
      );
      return served.sort().map((region) => ({ region, healthy: healthy.has(region) }));
    },

    async regionsCovered() {
      const down = (await service.regionHealth()).filter((r) => !r.healthy).map((r) => r.region);
      if (down.length > 0) throw new Error(`no healthy probe in ${down.join(", ")}`);
    },

    healthyRegions({ regions, workspaceId }) {
      const now = clock.now();
      return repo.healthyRegions({
        regions,
        workspaceId,
        now,
        seenAfter: new Date(now.getTime() - PROBE_HEALTHY_MS),
      });
    },

    async testNow(scope, monitorId) {
      const [monitor] = await deps.monitors.getForProbes([monitorId]);
      if (monitor === undefined || monitor.workspaceId !== scope.workspaceId) {
        throw new NotFoundError("Monitor not found.");
      }
      if (!PROBE_MONITOR_TYPES.includes(monitor.config.type)) {
        throw new ValidationError(`"${monitor.config.type}" monitors aren't run by probes.`);
      }
      if (monitor.paused) {
        /* Probes drop paused monitors, so the test would wait forever. */
        throw new ValidationError("This monitor is paused; resume it to run a test.");
      }
      const regions = monitor.regions.length ? monitor.regions : [...LAUNCH_REGIONS];
      const ids = await deps.db.transaction((tx) =>
        service.createTasks(tx, {
          workspaceId: scope.workspaceId,
          monitorId,
          kind: "test",
          regions,
        }),
      );
      return Promise.all(ids.map((id) => service.getTask(scope, id)));
    },

    async getTask(scope, taskId) {
      const row = await repo.findTask(scope, taskId);
      if (row === undefined) throw new NotFoundError("Task not found.");
      return view(row);
    },

    async pollTasks(probe, waitSeconds) {
      const filter = {
        region: probe.region,
        workspaceId: probe.kind === "private" ? probe.workspaceId : null,
      };
      const deadline = Date.now() + waitSeconds * 1_000;
      for (;;) {
        const claimed = await repo.claimTasks(probe.id, filter, 20);
        if (claimed.length > 0) {
          const monitors = new Map(
            (await deps.monitors.getForProbes([...new Set(claimed.map((t) => t.monitorId))])).map(
              (m) => [m.id, m],
            ),
          );
          return claimed.flatMap((task) => {
            const monitor = monitors.get(task.monitorId);
            if (monitor === undefined) return [];
            return [
              {
                id: task.id,
                kind: task.kind,
                monitor: toAssigned(monitor),
                deadline: task.expiresAt.toISOString(),
              },
            ];
          });
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) return [];
        await deps.notifier.wait(notifyKeyFor(probe), remaining);
      }
    },

    async completeTasks(tx, probeId, results) {
      const done = results
        .filter((r) => r.taskId !== undefined)
        .map((r) => ({
          taskId: r.taskId as string,
          resultId: r.id,
          result: r as unknown as Record<string, unknown>,
        }));
      if (done.length > 0) await repo.completeTasks(tx, probeId, done);
    },

    close: () => deps.notifier.close(),
  };
  return service;
}
