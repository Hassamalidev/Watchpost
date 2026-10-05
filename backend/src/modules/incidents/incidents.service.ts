/*
 * Incident lifecycle (PRODUCT.md §6.3, §9.3). Detection and heartbeats open and resolve incidents inside
 * their own transactions (pass `tx`); people act through the API (acknowledge, resolve, comment, false
 * alarm, manual incidents). Every change writes an incident_events row — the timeline is the audit
 * trail — and emits an outbox event in the same transaction.
 */
import {
  describeEvidenceTiming,
  evidenceBundleSchema,
  evidenceKeyPrefix,
  evidenceRefSchema,
  explainFailure,
  noiseLevel,
  suggestTuning,
  type Explanation,
  type IncidentEvidenceItem,
  type NoiseStats,
  type TuningSettings,
  type TuningSuggestion,
} from "@app/shared";
import type { Clock } from "../../core/clock.js";
import { ConflictError, NotFoundError } from "../../core/errors.js";
import { createWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import type { Db, DbOrTx, Tx } from "../../infra/db/index.js";
import type { Outbox } from "../../infra/outbox/index.js";
import type { ObjectStore } from "../../infra/storage/index.js";
import { DEPLOY_SUSPECT_MINUTES, type DeploysService } from "../deploys/index.js";
import type { MonitorsService } from "../monitors/index.js";
import type { WorkspacesService } from "../workspaces/index.js";
import type { IncidentFilters, IncidentRef, IncidentsRepository } from "./incidents.repository.js";
import type {
  IncidentCommentRow,
  IncidentEventRow,
  IncidentRow,
  IncidentSeverity,
} from "./schema/incidents.js";

export interface OpenForMonitorInput {
  workspaceId: string;
  monitorId: string;
  title: string;
  severity: IncidentSeverity;
  causeCode: string | null;
  failingRegions: string[];
  evidence?: Record<string, unknown>;
  /* Who opens it: detection ("monitor", the default) or the heartbeat sweeper. */
  source?: "monitor" | "heartbeat";
}

export interface IncidentView {
  id: string;
  number: number;
  source: IncidentRow["source"];
  monitorId: string | null;
  title: string;
  severity: IncidentSeverity;
  status: IncidentRow["status"];
  causeCode: string | null;
  failingRegions: string[];
  evidence: Record<string, unknown> | null;
  flapping: boolean;
  startedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  autoResolved: boolean;
  falseAlarm: boolean;
  snoozedUntil: string | null;
  durationSeconds: number;
}

export interface TimelineEntry {
  id: string;
  at: string;
  type: string;
  actor: string;
  data: Record<string, unknown>;
}

export interface CommentView {
  id: string;
  authorId: string;
  body: string;
  createdAt: string;
}

export interface IncidentMonitor {
  id: string;
  name: string;
  target: string | null;
  regionCount: number;
}

export interface IncidentDetail extends IncidentView {
  timeline: TimelineEntry[];
  comments: CommentView[];
  monitor: IncidentMonitor | null;
  /* The likely cause and first checks, as alerts show them; null when we can't say. */
  explanation: Explanation | null;
  /* How long the first failing check took and where the time went; null when it wasn't timed. */
  timing: string | null;
  recentDeploy: RecentDeploy | null;
}

/* One explanation for alerts and the incident page (§4 pillar 2). */
export function explainIncident(
  incident: Pick<IncidentView, "causeCode" | "evidence" | "failingRegions">,
  monitor: Pick<IncidentMonitor, "target" | "regionCount"> | null,
  deploy: RecentDeploy | null = null,
): Explanation | null {
  if (incident.causeCode === null) return null;
  const evidence = incident.evidence ?? {};
  const explanation = explainFailure({
    errorCode: incident.causeCode,
    httpStatus: typeof evidence.httpStatus === "number" ? evidence.httpStatus : null,
    failingRegions: incident.failingRegions,
    totalRegions: monitor?.regionCount,
    target: monitor?.target,
  });
  if (explanation.category === "unknown") return null;
  if (deploy === null) return explanation;
  /* A fresh deploy is the most likely culprit for almost any failure: check it first. */
  const where = deploy.environment ? ` to ${deploy.environment}` : "";
  const what = deploy.service ? `${deploy.service} ${deploy.version}` : deploy.version;
  const when = deploy.minutesBefore < 1 ? "less than a minute" : `${deploy.minutesBefore} min`;
  return {
    ...explanation,
    nextSteps: [
      `Deploy ${what}${where} went out ${when} before this started; roll it back if the timing fits.`,
      ...explanation.nextSteps,
    ],
  };
}

/* Everything alerting needs to route and render an incident's notifications. */
export interface AlertContext {
  workspaceId: string;
  incident: IncidentView;
  monitor: {
    id: string;
    name: string;
    alertPolicyId: string | null;
    reminderMinutes: number | null;
    /* Hostname it checks and how many regions check it, for the failure explanation. */
    target: string | null;
    regionCount: number;
  } | null;
  recentDeploy: RecentDeploy | null;
}

/* A deploy shortly before the incident started: the first suspect. */
export interface RecentDeploy {
  version: string;
  service: string | null;
  environment: string | null;
  url: string | null;
  deployedAt: string;
  minutesBefore: number;
}

export interface ExpiryIncidentInput {
  workspaceId: string;
  monitorId: string;
  /* One open incident per key, for example `ssl:<monitorId>`. */
  dedupKey: string;
  title: string;
  causeCode: string;
  evidence: Record<string, unknown>;
}

export interface IncidentSummary {
  days: number;
  incidents: number;
  resolved: number;
  falseAlarms: number;
  /* Share of incidents nobody marked as a false alarm; null without incidents. */
  accuracyPercent: number | null;
  mttaMinutes: number | null;
  mttrMinutes: number | null;
}

/* Monitor views carry regions as plain strings; the settings schema guarantees they are regions. */
type MonitorTuningRegions = TuningSettings["regions"];

export interface MonitorTuning {
  monitorId: string;
  name: string;
  stats: NoiseStats;
  suggestions: TuningSuggestion[];
}

export const DRILL_TITLE = "Alert drill: acknowledge this to finish the drill";

export interface CreateIncidentInput {
  title: string;
  severity: IncidentSeverity;
  monitorId?: string | undefined;
  note?: string | undefined;
}

export interface IncidentsService {
  /* System: opens an incident for a monitor, or returns the open one. `created` tells which. */
  openForMonitor(
    tx: Tx,
    input: OpenForMonitorInput,
  ): Promise<{ incident: IncidentRow; created: boolean }>;
  /* System: resolves the monitor's open incident, if any. */
  resolveForMonitor(
    tx: Tx,
    input: {
      monitorId: string;
      auto: boolean;
      byUserId?: string;
      /* Resolve only an incident this source opened (manual incidents stay open). */
      onlySource?: IncidentRow["source"];
    },
  ): Promise<IncidentRow | undefined>;
  setFlapping(tx: Tx, incidentId: string, flapping: boolean): Promise<void>;
  findOpenForMonitor(tx: DbOrTx, monitorId: string): Promise<IncidentRow | undefined>;
  /* System: routing and rendering context for alerting; undefined if the incident is gone. */
  alertContext(incidentId: string): Promise<AlertContext | undefined>;
  /*
   * System: opens a low-severity expiry incident, or updates the open one with the same key (new
   * title and evidence, an `updated` timeline entry and `incident.updated` so people hear about it).
   */
  openOrUpdateExpiry(
    tx: Tx,
    input: ExpiryIncidentInput,
  ): Promise<{ incident: IncidentRow; created: boolean }>;
  /* System: resolves the open incident with this key (after a renewal). */
  resolveByDedupKey(tx: Tx, workspaceId: string, dedupKey: string): Promise<boolean>;
  /*
   * Alert accuracy for the last `days` days: incidents, false alarms (marked by people), accuracy and
   * mean minutes to acknowledge and resolve. Drills and expiry warnings don't count.
   */
  summary(scope: WorkspaceScope, days: number): Promise<IncidentSummary>;
  /* Alert tuning advice for one monitor from its last 30 days (P1-T28). */
  tuning(scope: WorkspaceScope, monitorId: string): Promise<MonitorTuning>;
  /* The noisiest monitors of the last 30 days with their advice, noisiest first. */
  noisiest(scope: WorkspaceScope, limit: number): Promise<MonitorTuning[]>;
  /* Starts an alert drill: a real incident through every alert route, labelled as a drill. */
  startDrill(scope: WorkspaceScope): Promise<IncidentView>;
  /* System: incidents started in [from, to) — opened, resolved, mean minutes to resolve (digests). */
  stats(
    workspaceId: string,
    from: Date,
    to: Date,
  ): Promise<{ opened: number; resolved: number; mttrMinutes: number | null }>;
  /* System: IDs of open incidents, paged by ID (reminder recovery). */
  openIncidentIds(options: { afterId?: string; limit: number }): Promise<string[]>;
  /* System: a timeline entry written by the platform (for example `delivery_failed`). */
  addSystemEvent(incidentId: string, type: string, data: Record<string, unknown>): Promise<void>;

  /* API (tenant-scoped). `ref` is the incident ID or its per-workspace number. */
  list(
    scope: WorkspaceScope,
    filters: IncidentFilters,
  ): Promise<{ data: IncidentView[]; nextCursor: string | null }>;
  get(scope: WorkspaceScope, ref: string | number): Promise<IncidentDetail>;
  /*
   * What the failing checks saw when the incident opened, one item per failing region: response
   * headers, the start of the body, timings. Stored privately for 30 days and read only through here.
   */
  evidence(scope: WorkspaceScope, ref: string | number): Promise<IncidentEvidenceItem[]>;
  create(scope: WorkspaceScope, input: CreateIncidentInput): Promise<IncidentView>;
  /* `via` records where the action came from ("web" by default, "email" for action links). */
  acknowledge(
    scope: WorkspaceScope,
    ref: string | number,
    options?: { via?: string },
  ): Promise<IncidentView>;
  resolve(
    scope: WorkspaceScope,
    ref: string | number,
    options?: { via?: string },
  ): Promise<IncidentView>;
  comment(scope: WorkspaceScope, ref: string | number, body: string): Promise<CommentView>;
  setFalseAlarm(
    scope: WorkspaceScope,
    ref: string | number,
    falseAlarm: boolean,
  ): Promise<IncidentView>;
}

export interface IncidentsServiceDeps {
  db: Db;
  repository: IncidentsRepository;
  workspaces: Pick<WorkspacesService, "nextIncidentNumber">;
  monitors: Pick<MonitorsService, "get" | "getForDetection">;
  deploys: Pick<DeploysService, "latestBefore">;
  outbox: Outbox;
  clock: Clock;
  newId: () => string;
  /* Where evidence bundles live; without it incidents have none to show. */
  objects?: ObjectStore | undefined;
}

const toRef = (ref: string | number): IncidentRef =>
  typeof ref === "number" ? { number: ref } : { id: ref };

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

export function createIncidentsService(deps: IncidentsServiceDeps): IncidentsService {
  const { repository: repo, clock } = deps;

  /* The newest deploy in the half hour before a check-driven incident started. */
  async function recentDeployFor(row: IncidentRow): Promise<RecentDeploy | null> {
    if (row.source === "drill" || row.source === "expiry") return null;
    const deploy = await deps.deploys.latestBefore(
      createWorkspaceScope({ workspaceId: row.workspaceId }),
      row.startedAt,
      DEPLOY_SUSPECT_MINUTES,
    );
    if (deploy === undefined) return null;
    return {
      version: deploy.version,
      service: deploy.service,
      environment: deploy.environment,
      url: deploy.url,
      deployedAt: deploy.deployedAt,
      minutesBefore: Math.floor((row.startedAt.getTime() - Date.parse(deploy.deployedAt)) / 60_000),
    };
  }

  const tuningSince = () => new Date(clock.now().getTime() - 30 * 86_400_000);
  const tuningOf = (
    monitor: Awaited<ReturnType<MonitorsService["get"]>>,
    row: NoiseStats | undefined,
  ): MonitorTuning => {
    const stats: NoiseStats = {
      incidents: row?.incidents ?? 0,
      falseAlarms: row?.falseAlarms ?? 0,
      flapping: row?.flapping ?? 0,
      shortLived: row?.shortLived ?? 0,
    };
    return {
      monitorId: monitor.id,
      name: monitor.name,
      stats,
      suggestions:
        monitor.type === "heartbeat"
          ? []
          : suggestTuning(stats, {
              regions: monitor.regions as MonitorTuningRegions,
              minFailingRegions: monitor.minFailingRegions,
              recoverySuccesses: monitor.recoverySuccesses,
              intervalSeconds: monitor.intervalSeconds,
              timeoutMs: monitor.timeoutMs,
            }),
    };
  };

  const toView = (row: IncidentRow): IncidentView => {
    const end = row.resolvedAt ?? clock.now();
    return {
      id: row.id,
      number: row.number,
      source: row.source,
      monitorId: row.monitorId,
      title: row.title,
      severity: row.severity,
      status: row.status,
      causeCode: row.causeCode,
      failingRegions: row.failingRegions,
      evidence: row.evidence,
      flapping: row.flapping,
      startedAt: row.startedAt.toISOString(),
      acknowledgedAt: iso(row.ackedAt),
      acknowledgedBy: row.ackedBy,
      resolvedAt: iso(row.resolvedAt),
      resolvedBy: row.resolvedBy,
      autoResolved: row.autoResolved,
      falseAlarm: row.falseAlarm,
      snoozedUntil: iso(row.snoozedUntil),
      durationSeconds: Math.max(0, Math.round((end.getTime() - row.startedAt.getTime()) / 1_000)),
    };
  };
  const toEntry = (e: IncidentEventRow): TimelineEntry => ({
    id: e.id,
    at: e.at.toISOString(),
    type: e.type,
    actor: e.actor,
    data: e.data,
  });
  const toComment = (c: IncidentCommentRow): CommentView => ({
    id: c.id,
    authorId: c.authorId,
    body: c.body,
    createdAt: c.createdAt.toISOString(),
  });

  const actorOf = (scope: WorkspaceScope) => scope.actorUserId ?? "system";

  async function mustFind(tx: DbOrTx, scope: WorkspaceScope, ref: string | number, lock = false) {
    const row = await repo.findScoped(tx, scope, toRef(ref), lock);
    if (row === undefined) throw new NotFoundError("Incident not found.");
    return row;
  }

  async function addEvent(
    tx: Tx,
    incident: IncidentRow,
    type: string,
    actor: string,
    data: Record<string, unknown> = {},
  ) {
    await repo.addEvent(tx, {
      id: deps.newId(),
      incidentId: incident.id,
      workspaceId: incident.workspaceId,
      at: clock.now(),
      type,
      actor,
      data,
    });
  }

  async function markResolved(
    tx: Tx,
    open: IncidentRow,
    input: { auto: boolean; byUserId?: string | undefined; via?: string | undefined },
  ): Promise<IncidentRow | undefined> {
    const now = clock.now();
    const resolved = await repo.update(tx, open.id, {
      status: "resolved",
      resolvedAt: now,
      resolvedBy: input.byUserId ?? null,
      autoResolved: input.auto,
      flapping: false,
      snoozedUntil: null,
    });
    await addEvent(tx, open, "resolved", input.byUserId ?? "system", {
      auto: input.auto,
      ...(input.via === undefined ? {} : { via: input.via }),
      durationSeconds: Math.round((now.getTime() - open.startedAt.getTime()) / 1_000),
    });
    await deps.outbox.emit(
      tx,
      "incident.resolved",
      { incidentId: open.id, auto: input.auto },
      { workspaceId: open.workspaceId },
    );
    return resolved;
  }

  async function announceTriggered(tx: Tx, incident: IncidentRow, data: Record<string, unknown>) {
    await addEvent(tx, incident, "triggered", "system", data);
    await deps.outbox.emit(
      tx,
      "incident.triggered",
      {
        incidentId: incident.id,
        number: incident.number,
        ...(incident.monitorId === null ? {} : { monitorId: incident.monitorId }),
        severity: incident.severity,
        title: incident.title,
      },
      { workspaceId: incident.workspaceId },
    );
  }

  return {
    async openForMonitor(tx, input) {
      const existing = await repo.findOpenForMonitor(tx, input.monitorId);
      if (existing) return { incident: existing, created: false };

      const number = await deps.workspaces.nextIncidentNumber(
        tx,
        createWorkspaceScope({ workspaceId: input.workspaceId }),
      );
      const created = await repo.insertForMonitor(tx, {
        id: deps.newId(),
        workspaceId: input.workspaceId,
        number,
        source: input.source ?? "monitor",
        monitorId: input.monitorId,
        title: input.title,
        severity: input.severity,
        causeCode: input.causeCode,
        failingRegions: input.failingRegions,
        evidence: input.evidence ?? null,
        startedAt: clock.now(),
      });
      if (created === undefined) {
        /* Another transaction opened it first; the unique index kept us from a duplicate. */
        const winner = await repo.findOpenForMonitor(tx, input.monitorId);
        if (winner === undefined)
          throw new Error("open incident vanished during a concurrent insert");
        return { incident: winner, created: false };
      }
      await announceTriggered(tx, created, {
        causeCode: input.causeCode,
        failingRegions: input.failingRegions,
      });
      return { incident: created, created: true };
    },

    async resolveForMonitor(tx, input) {
      const open = await repo.findOpenForMonitor(tx, input.monitorId, true);
      if (open === undefined) return undefined;
      if (input.onlySource !== undefined && open.source !== input.onlySource) return undefined;
      return markResolved(tx, open, input);
    },

    async setFlapping(tx, incidentId, flapping) {
      const incident = await repo.findById(tx, incidentId);
      if (incident === undefined || incident.flapping === flapping) return;
      await repo.update(tx, incidentId, { flapping });
      await addEvent(tx, incident, flapping ? "flapping_started" : "flapping_stopped", "system");
      if (flapping) {
        await deps.outbox.emit(
          tx,
          "incident.flapping_started",
          { incidentId },
          { workspaceId: incident.workspaceId },
        );
      }
    },

    findOpenForMonitor: (tx, monitorId) => repo.findOpenForMonitor(tx, monitorId),

    async alertContext(incidentId) {
      const row = await repo.findById(deps.db, incidentId);
      if (row === undefined) return undefined;
      const [monitor] =
        row.monitorId === null ? [] : await deps.monitors.getForDetection([row.monitorId]);
      return {
        workspaceId: row.workspaceId,
        recentDeploy: await recentDeployFor(row),
        incident: toView(row),
        monitor:
          monitor === undefined
            ? null
            : {
                id: monitor.id,
                name: monitor.name,
                alertPolicyId: monitor.alertPolicyId,
                reminderMinutes: monitor.policies.reminderMinutes ?? null,
                target: monitor.target,
                regionCount: monitor.regions.length,
              },
      };
    },

    openIncidentIds: (options) => repo.openIds(deps.db, options),

    async summary(scope, days) {
      const to = clock.now();
      const from = new Date(to.getTime() - days * 86_400_000);
      const s = await repo.stats(deps.db, scope.workspaceId, from, to);
      return {
        days,
        incidents: s.opened,
        resolved: s.resolved,
        falseAlarms: s.falseAlarms,
        accuracyPercent:
          s.opened === 0 ? null : Math.round((1 - s.falseAlarms / s.opened) * 1_000) / 10,
        mttaMinutes: s.mttaSeconds === null ? null : Math.round((s.mttaSeconds / 60) * 10) / 10,
        mttrMinutes: s.mttrSeconds === null ? null : Math.round((s.mttrSeconds / 60) * 10) / 10,
      };
    },

    async tuning(scope, monitorId) {
      const monitor = await deps.monitors.get(scope, monitorId);
      const [row] = await repo.noiseByMonitor(deps.db, scope, tuningSince(), monitorId);
      return tuningOf(monitor, row);
    },

    async noisiest(scope, limit) {
      const rows = (await repo.noiseByMonitor(deps.db, scope, tuningSince()))
        .filter((r) => noiseLevel(r) > 0)
        .sort((a, b) => noiseLevel(b) - noiseLevel(a))
        .slice(0, limit);
      const out: MonitorTuning[] = [];
      for (const row of rows) {
        try {
          out.push(tuningOf(await deps.monitors.get(scope, row.monitorId), row));
        } catch (err) {
          /* Deleted since: its incidents stay, its advice doesn't. */
          if (!(err instanceof NotFoundError)) throw err;
        }
      }
      return out;
    },

    async startDrill(scope) {
      return deps.db.transaction(async (tx) => {
        const number = await deps.workspaces.nextIncidentNumber(tx, scope);
        const created = await repo.insertScoped(tx, scope, {
          id: deps.newId(),
          number,
          source: "drill",
          monitorId: null,
          title: DRILL_TITLE,
          severity: "high",
          startedAt: clock.now(),
        });
        if (created === undefined) throw new ConflictError("The drill couldn't start.");
        await announceTriggered(tx, created, { drill: true, by: actorOf(scope) });
        return toView(created);
      });
    },

    async stats(workspaceId, from, to) {
      const s = await repo.stats(deps.db, workspaceId, from, to);
      return {
        opened: s.opened,
        resolved: s.resolved,
        mttrMinutes: s.mttrSeconds === null ? null : s.mttrSeconds / 60,
      };
    },

    async openOrUpdateExpiry(tx, input) {
      const existing = await repo.findOpenByDedupKey(tx, input.workspaceId, input.dedupKey);
      if (existing !== undefined) {
        const updated = await repo.update(tx, existing.id, {
          title: input.title,
          causeCode: input.causeCode,
          evidence: input.evidence,
        });
        await addEvent(tx, existing, "updated", "system", { title: input.title });
        await deps.outbox.emit(
          tx,
          "incident.updated",
          { incidentId: existing.id, reason: input.title.slice(0, 300) },
          { workspaceId: existing.workspaceId },
        );
        return { incident: updated ?? existing, created: false };
      }
      const number = await deps.workspaces.nextIncidentNumber(
        tx,
        createWorkspaceScope({ workspaceId: input.workspaceId }),
      );
      const created = await repo.insertDeduplicated(tx, {
        id: deps.newId(),
        workspaceId: input.workspaceId,
        number,
        source: "expiry",
        monitorId: input.monitorId,
        dedupKey: input.dedupKey,
        title: input.title,
        severity: "low",
        causeCode: input.causeCode,
        failingRegions: [],
        evidence: input.evidence,
        startedAt: clock.now(),
      });
      if (created === undefined) {
        throw new Error(`an open incident with key ${input.dedupKey} appeared concurrently`);
      }
      await announceTriggered(tx, created, { causeCode: input.causeCode });
      return { incident: created, created: true };
    },

    async resolveByDedupKey(tx, workspaceId, dedupKey) {
      const open = await repo.findOpenByDedupKey(tx, workspaceId, dedupKey);
      if (open === undefined) return false;
      await markResolved(tx, open, { auto: true });
      return true;
    },

    async addSystemEvent(incidentId, type, data) {
      await deps.db.transaction(async (tx) => {
        const incident = await repo.findById(tx, incidentId);
        if (incident !== undefined) await addEvent(tx, incident, type, "system", data);
      });
    },

    async list(scope, filters) {
      const rows = await repo.list(deps.db, scope, filters);
      return {
        data: rows.map(toView),
        nextCursor: rows.length === filters.limit ? (rows.at(-1)?.id ?? null) : null,
      };
    },

    async get(scope, ref) {
      const row = await mustFind(deps.db, scope, ref);
      const [events, comments] = await Promise.all([
        repo.events(deps.db, scope, row.id),
        repo.comments(deps.db, scope, row.id),
      ]);
      const [found] =
        row.monitorId === null ? [] : await deps.monitors.getForDetection([row.monitorId]);
      const monitor =
        found === undefined
          ? null
          : {
              id: found.id,
              name: found.name,
              target: found.target,
              regionCount: found.regions.length,
            };
      const view = toView(row);
      const recentDeploy = await recentDeployFor(row);
      return {
        ...view,
        timeline: events.map(toEntry),
        comments: comments.map(toComment),
        monitor,
        explanation: explainIncident(view, monitor, recentDeploy),
        timing: describeEvidenceTiming(view.evidence),
        recentDeploy,
      };
    },

    async evidence(scope, ref) {
      const row = await mustFind(deps.db, scope, ref);
      const refs = evidenceRefSchema
        .array()
        .safeParse((row.evidence as { bundles?: unknown } | null)?.bundles ?? []);
      if (!refs.success) return [];
      const prefix = evidenceKeyPrefix(scope.workspaceId);
      const items: IncidentEvidenceItem[] = [];
      for (const item of refs.data) {
        const missing = {
          region: item.region,
          checkedAt: item.checkedAt,
          available: false,
        } as const;
        /* The key names its workspace: a row pointing elsewhere is never followed. */
        if (deps.objects === undefined || !item.key.startsWith(prefix)) {
          items.push(missing);
          continue;
        }
        try {
          const stored = await deps.objects.get(item.key);
          const bundle =
            stored === undefined
              ? undefined
              : evidenceBundleSchema.safeParse(JSON.parse(stored.toString("utf8")));
          items.push(
            bundle?.success === true
              ? {
                  region: item.region,
                  checkedAt: item.checkedAt,
                  available: true,
                  bundle: bundle.data,
                }
              : missing,
          );
        } catch {
          /* Storage is unreachable or the object is damaged: the page says it isn't available. */
          items.push(missing);
        }
      }
      return items;
    },

    async create(scope, input) {
      /* The monitor must be in this workspace (404 otherwise). */
      if (input.monitorId !== undefined) await deps.monitors.get(scope, input.monitorId);
      return deps.db.transaction(async (tx) => {
        const number = await deps.workspaces.nextIncidentNumber(tx, scope);
        const created = await repo.insertScoped(tx, scope, {
          id: deps.newId(),
          number,
          source: "manual",
          monitorId: input.monitorId ?? null,
          title: input.title,
          severity: input.severity,
          startedAt: clock.now(),
        });
        if (created === undefined) {
          throw new ConflictError("This monitor already has an open incident.");
        }
        await announceTriggered(tx, created, { manual: true, by: actorOf(scope) });
        if (input.note !== undefined && scope.actorUserId !== undefined) {
          const comment = await repo.insertComment(tx, scope, {
            id: deps.newId(),
            incidentId: created.id,
            authorId: scope.actorUserId,
            body: input.note,
          });
          await addEvent(tx, created, "comment", actorOf(scope), { commentId: comment.id });
        }
        return toView(created);
      });
    },

    async acknowledge(scope, ref, options = {}) {
      const via = options.via ?? "web";
      return deps.db.transaction(async (tx) => {
        const incident = await mustFind(tx, scope, ref, true);
        if (incident.status === "resolved") {
          throw new ConflictError("This incident is already resolved.");
        }
        if (incident.status === "acknowledged") return toView(incident);
        const updated = await repo.update(tx, incident.id, {
          status: "acknowledged",
          ackedAt: clock.now(),
          ackedBy: scope.actorUserId ?? null,
          snoozedUntil: null,
        });
        await addEvent(tx, incident, "acknowledged", actorOf(scope), { via });
        await deps.outbox.emit(
          tx,
          "incident.acknowledged",
          {
            incidentId: incident.id,
            ...(scope.actorUserId === undefined ? {} : { byUserId: scope.actorUserId }),
            via,
          },
          { workspaceId: incident.workspaceId },
        );
        return toView(updated ?? incident);
      });
    },

    async resolve(scope, ref, options = {}) {
      return deps.db.transaction(async (tx) => {
        const incident = await mustFind(tx, scope, ref, true);
        if (incident.status === "resolved") return toView(incident);
        const resolved = await markResolved(tx, incident, {
          auto: false,
          byUserId: scope.actorUserId,
          ...(options.via === undefined ? {} : { via: options.via }),
        });
        return toView(resolved ?? incident);
      });
    },

    async comment(scope, ref, body) {
      if (scope.actorUserId === undefined) {
        throw new ConflictError("Comments need a signed-in user.");
      }
      const authorId = scope.actorUserId;
      return deps.db.transaction(async (tx) => {
        const incident = await mustFind(tx, scope, ref);
        const comment = await repo.insertComment(tx, scope, {
          id: deps.newId(),
          incidentId: incident.id,
          authorId,
          body,
        });
        await addEvent(tx, incident, "comment", authorId, { commentId: comment.id });
        return toComment(comment);
      });
    },

    async setFalseAlarm(scope, ref, falseAlarm) {
      return deps.db.transaction(async (tx) => {
        const incident = await mustFind(tx, scope, ref, true);
        if (incident.falseAlarm === falseAlarm) return toView(incident);
        const updated = await repo.update(tx, incident.id, { falseAlarm });
        await addEvent(
          tx,
          incident,
          falseAlarm ? "false_alarm_marked" : "false_alarm_cleared",
          actorOf(scope),
        );
        if (falseAlarm) {
          await deps.outbox.emit(
            tx,
            "incident.false_alarm_marked",
            { incidentId: incident.id },
            { workspaceId: incident.workspaceId },
          );
        }
        return toView(updated ?? incident);
      });
    },
  };
}
