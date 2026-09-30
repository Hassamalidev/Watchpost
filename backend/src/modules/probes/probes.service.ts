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
import type { ProbesRepository } from "./probes.repository.js";
import type { ProbeRow } from "./schema/probes.js";
import type { TaskNotifier } from "./types/task-notifier.js";

export const SYNC_INTERVAL_MS = 15_000;
export const TASK_TTL_MS = 60_000;
export const VERIFY_WINDOW_MS = 30_000;
/* A probe not seen for this long is unhealthy: its region stops counting (§9.2). */
export const PROBE_HEALTHY_MS = 60_000;
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
  close(): Promise<void>;
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
}): ProbesService {
  const { repository: repo, clock } = deps;
  const authCache = new Map<
    string,
    { value: { probe: AuthenticatedProbe; secret: string }; until: number }
  >();
  /* Tasks are announced per region; private probes wake too and claim only their workspace's tasks. */
  const notifyKeyFor = (probe: { region: string }) => probe.region;

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
        let afterId: string | undefined;
        for (;;) {
          const page = await deps.monitors.listForProbes({
            limit: PAGE,
            ...(afterId ? { afterId } : {}),
          });
          for (const m of page) if (isAssigned(probe, m)) upserts.push(toAssigned(m));
          if (page.length < PAGE) break;
          afterId = page.at(-1)?.id;
        }
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
