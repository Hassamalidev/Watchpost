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
  type PostmortemView,
  type NoiseStats,
  type TuningSettings,
  type TuningSuggestion,
  aiExplanationSchema,
  type AiExplanation,
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
  IncidentStatus,
  PostmortemRow,
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
  /* Set while a parent monitor's incident explains this one: nobody is notified about it (§9.6). */
  suppressedByIncidentId: string | null;
  /* The AI explanation, once there is one; always shown labeled "AI" (§9.10). */
  aiSummary: StoredAiSummary | null;
}

export interface PostmortemSource {
  incidentId: string;
  number: number;
  title: string;
  /* Exact facts for the document's header, already worded. */
  facts: string[];
  /* The timeline as "time — what happened" lines, oldest first. */
  timeline: string[];
  /* The same material as structured evidence for the model. */
  evidence: Record<string, unknown>;
}

/* What a timeline entry means, in words; unknown kinds are shown by their name. */
const TIMELINE_WORDS: Record<string, string> = {
  triggered: "Incident opened",
  acknowledged: "Acknowledged",
  resolved: "Resolved",
  reopened: "Reopened",
  snoozed: "Snoozed",
  comment: "Comment added",
  escalated: "Escalated to the next step",
  delivery_failed: "An alert could not be delivered",
  flapping_started: "Started flapping",
  flapping_stopped: "Stopped flapping",
  false_alarm_marked: "Marked as a false alarm",
  false_alarm_cleared: "False-alarm mark removed",
  suppressed: "Kept quiet: a monitor it depends on was down",
  unsuppressed: "Announced: the monitor it depends on recovered",
  ai_summary: "AI summary added",
  updated: "Updated",
};
/* How many timeline entries a postmortem draws on; the first and last ones are kept. */
const POSTMORTEM_MAX_EVENTS = 120;

const utcMinute = (date: Date) => `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
const minutesBetween = (from: Date, to: Date) =>
  Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));

/* What is kept of an AI explanation on the incident. */
export interface StoredAiSummary extends AiExplanation {
  generationId: string;
  model: string;
  createdAt: string;
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
  /* The parent monitor's incident, while this one is suppressed by it. */
  suppressedBy: { id: string; number: number; title: string } | null;
}

/* An AI summary as stored, or null when the column is empty or was written by something else. */
function storedSummary(value: Record<string, unknown> | null): StoredAiSummary | null {
  if (value === null) return null;
  const parsed = aiExplanationSchema.safeParse({
    headline: value.headline,
    likelyCause: value.likelyCause,
    confidence: value.confidence,
    evidenceRefs: value.evidenceRefs,
    nextChecks: value.nextChecks,
  });
  if (!parsed.success || typeof value.generationId !== "string") return null;
  return {
    ...parsed.data,
    generationId: value.generationId,
    model: typeof value.model === "string" ? value.model : "",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
  };
}

/* How far up a dependency chain an explanation is looked for. */
const MAX_PARENT_DEPTH = 10;

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
    /* Set when the monitor's group asks for one message per burst of failures (§9.6). */
    alertGroup: { id: string; name: string } | null;
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

export interface InboundIncidentInput {
  workspaceId: string;
  /* One open incident per key; the inbound module scopes it to its source. */
  dedupKey: string;
  title: string;
  severity: IncidentSeverity;
  /* Where it came from and what the tool said, shown on the incident. */
  evidence: Record<string, unknown>;
}

/* An incident in one line, for a handoff report. */
export interface IncidentBrief {
  number: number;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  startedAt: string;
}

export interface ShiftReport {
  /* Incidents that started during the shift, newest first. */
  started: IncidentBrief[];
  /* How many of those are resolved. */
  resolved: number;
  /* Everything still open when the shift ended: what the next person inherits. */
  open: IncidentBrief[];
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
   * System: what a failing check saw, for the AI explainer: the incident's own facts and, when
   * stored, the first evidence bundle (response headers, start of the body, timings). Undefined if
   * the incident is gone.
   */
  aiEvidence(
    incidentId: string,
  ): Promise<{ workspaceId: string; evidence: Record<string, unknown> } | undefined>;
  /*
   * System: stores an AI explanation on the incident and tells subscribers it is there. Returns
   * false when the incident is gone or already has this one.
   */
  setAiSummary(incidentId: string, summary: StoredAiSummary): Promise<boolean>;
  /*
   * System: opens a low-severity expiry incident, or updates the open one with the same key (new
   * title and evidence, an `updated` timeline entry and `incident.updated` so people hear about it).
   */
  openOrUpdateExpiry(
    tx: Tx,
    input: ExpiryIncidentInput,
  ): Promise<{ incident: IncidentRow; created: boolean }>;
  /*
   * System: opens an incident for an alert from another tool, unless one with the same key is
   * already open (then `created` is false and nothing changes: no second alert for a repeat).
   */
  openInbound(
    tx: Tx,
    input: InboundIncidentInput,
  ): Promise<{ incident: IncidentRow; created: boolean }>;
  /* System: resolves the open incident with this key (after a renewal, or the tool's recovery). */
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
  /*
   * Per monitor, incidents started in [from, to) with the sums behind MTTA and MTTR (SLA reports).
   * Expiry warnings and drills don't count, as everywhere else.
   */
  statsByMonitor(
    scope: WorkspaceScope,
    monitorIds: string[],
    from: Date,
    to: Date,
  ): Promise<
    Array<{
      monitorId: string;
      opened: number;
      acked: number;
      resolved: number;
      ackSeconds: number;
      resolveSeconds: number;
    }>
  >;
  /* System: what happened in a workspace between two moments, for an on-call handoff. */
  shiftReport(workspaceId: string, from: Date, to: Date): Promise<ShiftReport>;
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
  /* The incident's written review, or null when nobody has started one. */
  postmortem(scope: WorkspaceScope, ref: string | number): Promise<PostmortemView | null>;
  /* Saves the review's text. `aiGenerationId` records that it started as an AI draft. */
  savePostmortem(
    scope: WorkspaceScope,
    ref: string | number,
    input: { markdown: string; aiGenerationId?: string | undefined },
  ): Promise<PostmortemView>;
  /*
   * What a postmortem is written from (§6.9): the incident's facts and its timeline in order, with
   * people named by role only. `facts` are the lines our own records can state exactly.
   */
  postmortemSource(scope: WorkspaceScope, ref: string | number): Promise<PostmortemSource>;
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
      suppressedByIncidentId: row.suppressedByIncidentId ?? null,
      aiSummary: storedSummary(row.aiSummary),
    };
  };
  const toEntry = (e: IncidentEventRow): TimelineEntry => ({
    id: e.id,
    at: e.at.toISOString(),
    type: e.type,
    actor: e.actor,
    data: e.data,
  });
  const toPostmortem = (row: PostmortemRow): PostmortemView => ({
    markdown: row.markdown,
    aiDrafted: row.aiGenerationId !== null,
    updatedAt: row.updatedAt.toISOString(),
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
    await releaseSuppressed(tx, open);
    return resolved;
  }

  /*
   * Dependencies (§9.6): the open incident of the nearest ancestor that is down explains a monitor's
   * failure. `ignore` holds monitors whose incidents don't count (they are being decided right now).
   */
  async function openAncestorIncident(
    tx: DbOrTx,
    monitorId: string,
    ignore: ReadonlySet<string> = new Set(),
  ): Promise<IncidentRow | undefined> {
    const [monitor] = await deps.monitors.getForDetection([monitorId]);
    let parentId = monitor?.parentId ?? null;
    for (let depth = 0; parentId !== null && depth < MAX_PARENT_DEPTH; depth += 1) {
      const [parent] = await deps.monitors.getForDetection([parentId]);
      /* Parents are in the same workspace by construction; stop if a row ever says otherwise. */
      if (parent === undefined || parent.workspaceId !== monitor?.workspaceId) return undefined;
      if (!ignore.has(parentId)) {
        const open = await repo.findOpenForMonitor(tx, parentId);
        if (open !== undefined && (open.source === "monitor" || open.source === "heartbeat")) {
          return open;
        }
      }
      parentId = parent.parentId;
    }
    return undefined;
  }

  /*
   * An incident stopped explaining others (it resolved). Each incident it kept quiet is looked at
   * again: one that still has an ancestor with an open incident stays quiet under that one; the
   * rest are real outages of their own now, so they are announced.
   */
  async function releaseSuppressed(tx: Tx, parent: IncidentRow): Promise<void> {
    let waiting = await repo.openSuppressedBy(tx, parent.id);
    while (waiting.length > 0) {
      const undecided = new Set(
        waiting.flatMap((c) => (c.monitorId === null ? [] : [c.monitorId])),
      );
      const later: IncidentRow[] = [];
      for (const child of waiting) {
        /* An ancestor that is itself waiting is decided first, so its answer can be used. */
        const blockedBy =
          child.monitorId === null ? undefined : await nearestWaiting(child.monitorId, undecided);
        if (blockedBy !== undefined) {
          later.push(child);
          continue;
        }
        const ancestor =
          child.monitorId === null ? undefined : await openAncestorIncident(tx, child.monitorId);
        if (child.monitorId !== null) undecided.delete(child.monitorId);
        if (ancestor !== undefined) {
          const by = ancestor.suppressedByIncidentId ?? ancestor.id;
          await repo.update(tx, child.id, { suppressedByIncidentId: by });
          await addEvent(tx, child, "suppressed", "system", { byIncidentId: by });
          continue;
        }
        const released = await repo.update(tx, child.id, { suppressedByIncidentId: null });
        if (released === undefined) continue;
        await addEvent(tx, released, "unsuppressed", "system", { byIncidentId: parent.id });
        await emitTriggered(tx, released);
      }
      /* No progress is impossible in a tree; stop rather than loop if the data ever says otherwise. */
      if (later.length === waiting.length) break;
      waiting = later;
    }
  }

  /* The nearest ancestor of a monitor that is in `set`, if any. */
  async function nearestWaiting(
    monitorId: string,
    set: ReadonlySet<string>,
  ): Promise<string | undefined> {
    const [monitor] = await deps.monitors.getForDetection([monitorId]);
    let parentId = monitor?.parentId ?? null;
    for (let depth = 0; parentId !== null && depth < MAX_PARENT_DEPTH; depth += 1) {
      if (set.has(parentId)) return parentId;
      const [parent] = await deps.monitors.getForDetection([parentId]);
      parentId = parent?.parentId ?? null;
    }
    return undefined;
  }

  async function suppressorOf(row: IncidentRow): Promise<IncidentDetail["suppressedBy"]> {
    if (row.suppressedByIncidentId === null) return null;
    const parent = await repo.findById(deps.db, row.suppressedByIncidentId);
    /* Never across workspaces, whatever the row says. */
    if (parent === undefined || parent.workspaceId !== row.workspaceId) return null;
    return { id: parent.id, number: parent.number, title: parent.title };
  }

  async function announceTriggered(tx: Tx, incident: IncidentRow, data: Record<string, unknown>) {
    await addEvent(tx, incident, "triggered", "system", data);
    await emitTriggered(tx, incident);
  }

  async function emitTriggered(tx: Tx, incident: IncidentRow) {
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

  const service: IncidentsService = {
    async openForMonitor(tx, input) {
      const existing = await repo.findOpenForMonitor(tx, input.monitorId);
      if (existing) return { incident: existing, created: false };

      const number = await deps.workspaces.nextIncidentNumber(
        tx,
        createWorkspaceScope({ workspaceId: input.workspaceId }),
      );
      /* A parent that is already down explains this failure: open it on the record, quietly. */
      const ancestor = await openAncestorIncident(tx, input.monitorId);
      const suppressedBy =
        ancestor === undefined ? null : (ancestor.suppressedByIncidentId ?? ancestor.id);
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
        suppressedByIncidentId: suppressedBy,
        startedAt: clock.now(),
      });
      if (created === undefined) {
        /* Another transaction opened it first; the unique index kept us from a duplicate. */
        const winner = await repo.findOpenForMonitor(tx, input.monitorId);
        if (winner === undefined)
          throw new Error("open incident vanished during a concurrent insert");
        return { incident: winner, created: false };
      }
      const facts = { causeCode: input.causeCode, failingRegions: input.failingRegions };
      if (created.suppressedByIncidentId === null) {
        await announceTriggered(tx, created, facts);
      } else {
        /* On the timeline, but no `incident.triggered`: nothing is sent while the parent is down. */
        await addEvent(tx, created, "triggered", "system", facts);
        await addEvent(tx, created, "suppressed", "system", {
          byIncidentId: created.suppressedByIncidentId,
        });
      }
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

    async aiEvidence(incidentId) {
      const ctx = await service.alertContext(incidentId);
      if (ctx === undefined) return undefined;
      const { incident, monitor, recentDeploy } = ctx;
      const stored = incident.evidence ?? {};
      /* The bundle list is storage plumbing, not evidence. */
      const { bundles: _bundles, ...facts } = stored as Record<string, unknown>;
      void _bundles;
      let firstBundle: Record<string, unknown> | undefined;
      try {
        const items = await service.evidence(
          createWorkspaceScope({ workspaceId: ctx.workspaceId }),
          incident.id,
        );
        const available = items.find((item) => item.available);
        if (available?.available === true) {
          const { region, checkedAt, available: _yes, ...rest } = available;
          void _yes;
          firstBundle = { region, checkedAt, ...rest };
        }
      } catch {
        /* Evidence is a bonus: the explainer works from the incident's own facts without it. */
      }
      return {
        workspaceId: ctx.workspaceId,
        evidence: {
          title: incident.title,
          severity: incident.severity,
          source: incident.source,
          startedAt: incident.startedAt,
          monitor:
            monitor === null
              ? null
              : { name: monitor.name, target: monitor.target, regionCount: monitor.regionCount },
          causeCode: incident.causeCode,
          failingRegions: incident.failingRegions,
          timing: describeEvidenceTiming(incident.evidence),
          ...facts,
          ...(firstBundle === undefined ? {} : { failingCheck: firstBundle }),
          recentDeploy,
        },
      };
    },

    async setAiSummary(incidentId, summary) {
      return deps.db.transaction(async (tx) => {
        const incident = await repo.findById(tx, incidentId);
        if (incident === undefined) return false;
        if (storedSummary(incident.aiSummary)?.generationId === summary.generationId) return false;
        await repo.update(tx, incidentId, { aiSummary: { ...summary } });
        await addEvent(tx, incident, "ai_summary", "system", {
          generationId: summary.generationId,
          headline: summary.headline,
        });
        await deps.outbox.emit(
          tx,
          "incident.ai_summary_ready",
          { incidentId, generationId: summary.generationId },
          { workspaceId: incident.workspaceId },
        );
        return true;
      });
    },

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
                alertGroup:
                  monitor.group !== null && monitor.group.groupAlerts
                    ? { id: monitor.group.id, name: monitor.group.name }
                    : null,
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

    statsByMonitor: (scope, monitorIds, from, to) =>
      repo.statsByMonitor(deps.db, scope.workspaceId, monitorIds, from, to),

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

    async openInbound(tx, input) {
      const existing = await repo.findOpenByDedupKey(tx, input.workspaceId, input.dedupKey);
      if (existing !== undefined) return { incident: existing, created: false };
      const number = await deps.workspaces.nextIncidentNumber(
        tx,
        createWorkspaceScope({ workspaceId: input.workspaceId }),
      );
      const created = await repo.insertDeduplicated(tx, {
        id: deps.newId(),
        workspaceId: input.workspaceId,
        number,
        source: "inbound",
        monitorId: null,
        dedupKey: input.dedupKey,
        title: input.title,
        severity: input.severity,
        failingRegions: [],
        evidence: input.evidence,
        startedAt: clock.now(),
      });
      /* Two deliveries of the same alert at once: the other one opened it. */
      if (created === undefined) {
        const winner = await repo.findOpenByDedupKey(tx, input.workspaceId, input.dedupKey);
        if (winner === undefined) throw new Error(`incident ${input.dedupKey} vanished`);
        return { incident: winner, created: false };
      }
      await announceTriggered(tx, created, {});
      return { incident: created, created: true };
    },

    async resolveByDedupKey(tx, workspaceId, dedupKey) {
      const open = await repo.findOpenByDedupKey(tx, workspaceId, dedupKey);
      if (open === undefined) return false;
      await markResolved(tx, open, { auto: true });
      return true;
    },

    async shiftReport(workspaceId, from, to) {
      const brief = (row: IncidentRow): IncidentBrief => ({
        number: row.number,
        title: row.title,
        severity: row.severity,
        status: row.status,
        startedAt: row.startedAt.toISOString(),
      });
      const [started, open] = await Promise.all([
        repo.startedBetween(deps.db, workspaceId, from, to, 50),
        repo.stillOpen(deps.db, workspaceId, 20),
      ]);
      return {
        started: started.map(brief),
        resolved: started.filter((row) => row.status === "resolved").length,
        open: open.map(brief),
      };
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
        suppressedBy: await suppressorOf(row),
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

    async postmortem(scope, ref) {
      const row = await mustFind(deps.db, scope, ref);
      const stored = await repo.findPostmortem(deps.db, row.id);
      return stored === undefined ? null : toPostmortem(stored);
    },

    async savePostmortem(scope, ref, input) {
      return deps.db.transaction(async (tx) => {
        const row = await mustFind(tx, scope, ref, true);
        const existed = (await repo.findPostmortem(tx, row.id)) !== undefined;
        const saved = await repo.savePostmortem(
          tx,
          {
            incidentId: row.id,
            workspaceId: row.workspaceId,
            markdown: input.markdown,
            updatedBy: scope.actorUserId ?? null,
            aiGenerationId: input.aiGenerationId ?? null,
          },
          clock.now(),
        );
        if (!existed) {
          await addEvent(tx, row, "postmortem_started", actorOf(scope), {
            aiDrafted: input.aiGenerationId !== undefined,
          });
        }
        return toPostmortem(saved);
      });
    },

    async postmortemSource(scope, ref) {
      const detail = await service.get(scope, ref);
      const started = new Date(detail.startedAt);
      const facts = [
        `Incident #${detail.number}: ${detail.title}`,
        `Severity: ${detail.severity}`,
        ...(detail.monitor === null ? [] : [`Monitor: ${detail.monitor.name}`]),
        `Started: ${utcMinute(started)}`,
        ...(detail.acknowledgedAt === null
          ? []
          : [
              `Acknowledged: ${utcMinute(new Date(detail.acknowledgedAt))} (${minutesBetween(started, new Date(detail.acknowledgedAt))} min after it started)`,
            ]),
        ...(detail.resolvedAt === null
          ? ["Not resolved yet"]
          : [
              `Resolved: ${utcMinute(new Date(detail.resolvedAt))} (${minutesBetween(started, new Date(detail.resolvedAt))} min after it started)`,
            ]),
        ...(detail.failingRegions.length > 0
          ? [`Failing regions: ${detail.failingRegions.join(", ")}`]
          : []),
        ...(detail.causeCode === null ? [] : [`Cause code: ${detail.causeCode}`]),
        ...(detail.recentDeploy === null
          ? []
          : [
              `Deploy ${detail.recentDeploy.minutesBefore} min before: ${[detail.recentDeploy.service, detail.recentDeploy.version].filter(Boolean).join(" ")}`,
            ]),
      ];
      /* A long incident keeps its beginning and its end; the middle is what gets cut. */
      const all = detail.timeline;
      const head = Math.ceil(POSTMORTEM_MAX_EVENTS / 2);
      const entries =
        all.length <= POSTMORTEM_MAX_EVENTS
          ? all
          : [...all.slice(0, head), ...all.slice(all.length - (POSTMORTEM_MAX_EVENTS - head))];
      const comments = new Map(detail.comments.map((c) => [c.id, c.body]));
      const lineOf = (entry: TimelineEntry) => {
        const what = TIMELINE_WORDS[entry.type] ?? entry.type;
        const by = entry.actor === "system" ? "" : " by a team member";
        const comment =
          entry.type === "comment" && typeof entry.data.commentId === "string"
            ? `: ${comments.get(entry.data.commentId) ?? ""}`
            : "";
        return `${utcMinute(new Date(entry.at))} — ${what}${by}${comment}`;
      };
      const timeline = entries.map(lineOf);
      return {
        incidentId: detail.id,
        number: detail.number,
        title: detail.title,
        facts,
        timeline,
        evidence: {
          facts,
          timeline,
          omittedEvents: all.length - entries.length,
          explanation: detail.explanation?.headline ?? null,
          timing: detail.timing,
          aiSummary: detail.aiSummary?.likelyCause ?? null,
          falseAlarm: detail.falseAlarm,
        },
      };
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
  return service;
}
