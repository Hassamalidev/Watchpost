/*
 * Incident lifecycle (PRODUCT.md §6.3, §9.3). Detection and heartbeats open and resolve incidents inside
 * their own transactions (pass `tx`); people act through the API (acknowledge, resolve, comment, false
 * alarm, manual incidents). Every change writes an incident_events row — the timeline is the audit
 * trail — and emits an outbox event in the same transaction.
 */
import type { Clock } from "../../core/clock.js";
import { ConflictError, NotFoundError } from "../../core/errors.js";
import { createWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import type { Db, DbOrTx, Tx } from "../../infra/db/index.js";
import type { Outbox } from "../../infra/outbox/index.js";
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

export interface IncidentDetail extends IncidentView {
  timeline: TimelineEntry[];
  comments: CommentView[];
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
  } | null;
}

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
  create(scope: WorkspaceScope, input: CreateIncidentInput): Promise<IncidentView>;
  acknowledge(scope: WorkspaceScope, ref: string | number): Promise<IncidentView>;
  resolve(scope: WorkspaceScope, ref: string | number): Promise<IncidentView>;
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
  outbox: Outbox;
  clock: Clock;
  newId: () => string;
}

const toRef = (ref: string | number): IncidentRef =>
  typeof ref === "number" ? { number: ref } : { id: ref };

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

export function createIncidentsService(deps: IncidentsServiceDeps): IncidentsService {
  const { repository: repo, clock } = deps;

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
    input: { auto: boolean; byUserId?: string | undefined },
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
        incident: toView(row),
        monitor:
          monitor === undefined
            ? null
            : {
                id: monitor.id,
                name: monitor.name,
                alertPolicyId: monitor.alertPolicyId,
                reminderMinutes: monitor.policies.reminderMinutes ?? null,
              },
      };
    },

    openIncidentIds: (options) => repo.openIds(deps.db, options),

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
      return { ...toView(row), timeline: events.map(toEntry), comments: comments.map(toComment) };
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

    async acknowledge(scope, ref) {
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
        await addEvent(tx, incident, "acknowledged", actorOf(scope), { via: "web" });
        await deps.outbox.emit(
          tx,
          "incident.acknowledged",
          {
            incidentId: incident.id,
            ...(scope.actorUserId === undefined ? {} : { byUserId: scope.actorUserId }),
            via: "web",
          },
          { workspaceId: incident.workspaceId },
        );
        return toView(updated ?? incident);
      });
    },

    async resolve(scope, ref) {
      return deps.db.transaction(async (tx) => {
        const incident = await mustFind(tx, scope, ref, true);
        if (incident.status === "resolved") return toView(incident);
        const resolved = await markResolved(tx, incident, {
          auto: false,
          byUserId: scope.actorUserId,
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
