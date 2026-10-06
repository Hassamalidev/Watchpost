/*
 * Notification pipeline (PRODUCT.md §9.4). An incident event becomes one notification_deliveries row
 * per destination of the incident's alert policy (the monitor's, else the workspace default), and one
 * `notify` job per row. A delivery is claimed before each attempt, so a job that runs again after a
 * success sends nothing. Failures retry with backoff; the last failure (or a permanent one) marks the
 * delivery failed, the channel failing, writes a `delivery_failed` timeline entry and emails the
 * workspace admins, at most once an hour. Reminders repeat every N minutes while an incident is open.
 */
import {
  CHANNEL_CAPABILITIES,
  CHANNEL_LABELS,
  alertPolicyRulesSchema,
  channelAccepts,
  describeEvidenceTiming,
  type AlertEventKind,
  type AlertPolicyInput,
  type AlertPolicyRules,
  type IncidentEscalationView,
  urgencyOf,
} from "@app/shared";
import type { Clock } from "../../core/clock.js";
import { ConflictError, NotFoundError, ValidationError } from "../../core/errors.js";
import { createWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import type { Db } from "../../infra/db/index.js";
import type { Logger } from "../../infra/logger.js";
import type { Outbox } from "../../infra/outbox/index.js";
import type { EnqueueOptions } from "../../infra/queues/index.js";
import { buildJobId } from "../../infra/queues/index.js";
import {
  ChannelDeliveryError,
  type AlertEvent,
  type ChannelSummary,
  type ChannelsService,
} from "../channels/index.js";
import type { ContactsService } from "../contacts/index.js";
import type { CreditsService } from "../credits/index.js";
import { explainIncident, type AlertContext, type IncidentsService } from "../incidents/index.js";
import type { OncallService } from "../oncall/index.js";
import type { WorkspacesService } from "../workspaces/index.js";
import type { AlertingRepository } from "./alerting.repository.js";
import type { AlertPolicyRow, DeliveryRow, EscalationRow } from "./schema/alerting.js";

export const NOTIFY_ATTEMPTS = 5;
/* Exponential: 8 s, 16 s, 32 s, 64 s between the five attempts (about 2 minutes in all). */
export const NOTIFY_BACKOFF_MS = 8_000;
/* A delivery waiting or mid-send for this long has probably lost its job; the sweep re-queues it. */
export const STALE_DELIVERY_MS = 5 * 60_000;
const SWEEP_BATCH = 500;

export type TimerJob =
  | { kind: "reminder"; incidentId: string; dueAt: number }
  | { kind: "escalate"; incidentId: string; step: number; dueAt: number };

export type EscalationOutcome = "ran" | "stale" | "stopped" | "waiting";

/* Thrown to make BullMQ retry the notify job with backoff. */
export class RetryDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryDeliveryError";
  }
}

export interface AlertPolicyView {
  id: string;
  name: string;
  isDefault: boolean;
  rules: AlertPolicyRules;
  createdAt: string;
}

export interface DeliveryView {
  id: string;
  kind: AlertEventKind;
  channelId: string | null;
  status: DeliveryRow["status"];
  attempts: number;
  error: string | null;
  sentAt: string | null;
  /* For a delivery to a person: who, how, and when their rule says it goes out. */
  userId: string | null;
  contactType: DeliveryRow["contactType"];
  dueAt: string | null;
}

export interface DeliveryLogEntry extends DeliveryView {
  channelName: string | null;
  channelType: string | null;
  createdAt: string;
}

export type DeliveryOutcome = "sent" | "skipped" | "failed";

export interface AlertingService {
  listPolicies(scope: WorkspaceScope): Promise<AlertPolicyView[]>;
  createPolicy(scope: WorkspaceScope, input: AlertPolicyInput): Promise<AlertPolicyView>;
  updatePolicy(
    scope: WorkspaceScope,
    id: string,
    input: Partial<AlertPolicyInput>,
  ): Promise<AlertPolicyView>;
  deletePolicy(scope: WorkspaceScope, id: string): Promise<void>;
  /*
   * Makes the default policy send to a channel (what "connect an integration" does). Atomic and
   * idempotent: two admins adding channels at once both end up routed.
   */
  routeToDefault(scope: WorkspaceScope, channelId: string): Promise<AlertPolicyView>;
  /* Creates the workspace's default policy once (workspace.created). */
  ensureDefaultPolicy(workspaceId: string): Promise<boolean>;

  /* Plans deliveries for an incident event; returns how many were newly planned. */
  planIncidentEvent(input: {
    kind: AlertEventKind;
    incidentId: string;
    eventKey: string;
    actorUserId?: string | undefined;
  }): Promise<number>;
  /*
   * Tells one person about a triggered incident through their own contact methods, each at the
   * delay their rules give it (§9.5). Returns how many deliveries were newly planned. A delayed
   * delivery is dropped when the incident is no longer waiting for someone by then.
   */
  notifyUser(input: { incidentId: string; eventKey: string; userId: string }): Promise<number>;
  /*
   * Starts the escalation of a newly triggered incident, if its alert policy names an escalation
   * policy. Returns true when one was started.
   */
  startEscalation(incidentId: string): Promise<boolean>;
  /*
   * The `escalate` timer: runs step `step` if it is still the next one and the incident is still
   * waiting for someone, then schedules the step after it.
   */
  escalationDue(incidentId: string, step: number, dueAt: number): Promise<EscalationOutcome>;
  /* "Escalate now": runs the next step at once instead of waiting for its delay. */
  escalateNow(scope: WorkspaceScope, incidentId: string): Promise<IncidentEscalationView>;
  /* Where an incident's escalation stands; null when it has none. */
  escalationOf(scope: WorkspaceScope, incidentId: string): Promise<IncidentEscalationView | null>;
  /* Recovery: re-schedule the timer of every unfinished escalation. Returns how many. */
  recoverEscalations(): Promise<number>;
  /* One send attempt for a delivery (the notify job). Throws RetryDeliveryError to retry. */
  deliver(deliveryId: string): Promise<DeliveryOutcome>;
  /* Schedules the first reminder for a newly triggered incident, if its monitor wants reminders. */
  scheduleReminders(incidentId: string): Promise<boolean>;
  reminderDue(incidentId: string, dueAt: number): Promise<number>;
  onChannelHealth(channelId: string, status: "healthy" | "failing"): Promise<void>;
  /* "Send test": one test alert through a channel, right now, with the outcome. */
  sendTest(
    scope: WorkspaceScope,
    channelId: string,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  deliveriesFor(incidentId: string): Promise<DeliveryView[]>;
  /* The delivery log of an incident for the API, with channel names. */
  deliveryLog(scope: WorkspaceScope, incidentId: string): Promise<DeliveryLogEntry[]>;
  /* Recovery: re-queue deliveries whose jobs were lost. Returns how many. */
  recoverDeliveries(): Promise<number>;
  /* Recovery: re-schedule the next reminder of every open incident. Returns how many. */
  recoverReminders(): Promise<number>;
}

export interface AlertingServiceDeps {
  db: Db;
  repository: AlertingRepository;
  incidents: Pick<IncidentsService, "alertContext" | "openIncidentIds" | "addSystemEvent">;
  channels: Pick<
    ChannelsService,
    "existing" | "deliver" | "deliverDirect" | "markFailing" | "summary" | "retryPolicy"
  >;
  /* Personal rules; optional so tests can build alerting without contacts. */
  contacts?: Pick<ContactsService, "fanOut"> | undefined;
  /* Escalation policies and who is on call; optional so tests can build alerting without them. */
  oncall?: Pick<OncallService, "escalationPolicy" | "whoIsOnCall"> | undefined;
  workspaces: Pick<WorkspacesService, "listMembers" | "workspaceName">;
  /* Returns the credits of a paid message that failed for good; optional for tests. */
  credits?: Pick<CreditsService, "refundCharge"> | undefined;
  outbox: Outbox;
  clock: Clock;
  logger: Logger;
  newId: () => string;
  webOrigin: string;
  enqueueNotify: (deliveryId: string, options: EnqueueOptions) => Promise<void>;
  enqueueTimer: (job: TimerJob, options: EnqueueOptions) => Promise<void>;
}

const DEFAULT_RULES: AlertPolicyRules = alertPolicyRulesSchema.parse({});
/* The same cap as `alertPolicyRulesSchema.channelIds`. */
const MAX_POLICY_CHANNELS = 50;
const HOUR_MS = 3_600_000;

export function createAlertingService(deps: AlertingServiceDeps): AlertingService {
  const { repository: repo, clock } = deps;
  const system = (workspaceId: string) => createWorkspaceScope({ workspaceId });

  const toPolicy = (row: AlertPolicyRow): AlertPolicyView => ({
    id: row.id,
    name: row.name,
    isDefault: row.isDefault,
    rules: row.rules,
    createdAt: row.createdAt.toISOString(),
  });

  const toDelivery = (row: DeliveryRow): DeliveryView => ({
    id: row.id,
    kind: row.kind,
    channelId: row.channelId,
    status: row.status,
    attempts: row.attempts,
    error: row.error,
    sentAt: row.sentAt === null ? null : row.sentAt.toISOString(),
    userId: row.userId,
    contactType: row.contactType,
    dueAt: row.dueAt === null ? null : row.dueAt.toISOString(),
  });

  /*
   * Rules whose channels all exist. An unknown ID is refused, unless the policy already listed it:
   * that is a channel deleted since (`stale`), which is dropped instead, so a policy that outlived one
   * of its channels can still be edited.
   */
  async function checkChannels(
    scope: WorkspaceScope,
    rules: AlertPolicyRules,
    stale: readonly string[] = [],
  ): Promise<AlertPolicyRules> {
    const found = new Set((await deps.channels.existing(scope, rules.channelIds)).map((c) => c.id));
    const missing = rules.channelIds.filter((id) => !found.has(id) && !stale.includes(id));
    if (missing.length > 0) {
      throw new ValidationError(`Unknown channels: ${missing.join(", ")}.`);
    }
    return { ...rules, channelIds: rules.channelIds.filter((id) => found.has(id)) };
  }

  async function policyFor(ctx: AlertContext): Promise<AlertPolicyRow | undefined> {
    const scope = system(ctx.workspaceId);
    if (ctx.monitor?.alertPolicyId) {
      const own = await repo.findPolicy(deps.db, scope, ctx.monitor.alertPolicyId);
      if (own !== undefined) return own;
    }
    const fallback = await repo.findDefaultPolicy(deps.db, scope);
    if (fallback !== undefined) return fallback;
    await service.ensureDefaultPolicy(ctx.workspaceId);
    return repo.findDefaultPolicy(deps.db, scope);
  }

  async function memberName(workspaceId: string, userId: string | null | undefined) {
    if (!userId) return null;
    const members = await deps.workspaces.listMembers(system(workspaceId));
    return members.find((m) => m.userId === userId)?.name ?? null;
  }

  /* "Sara (email)": how a delivery to a person is named in logs and on the timeline. */
  async function personLabel(
    workspaceId: string,
    delivery: Pick<DeliveryRow, "userId" | "contactType">,
  ): Promise<string> {
    const name = (await memberName(workspaceId, delivery.userId)) ?? "A former member";
    return `${name} (${delivery.contactType === "sms" ? "SMS" : (delivery.contactType ?? "email")})`;
  }

  function eventFor(
    kind: AlertEventKind,
    ctx: AlertContext,
    workspaceName: string,
    actor: string | null,
  ): AlertEvent {
    const { incident } = ctx;
    return {
      kind,
      workspace: { id: ctx.workspaceId, name: workspaceName },
      incident: {
        id: incident.id,
        number: incident.number,
        title: incident.title,
        severity: incident.severity,
        status: incident.status,
        causeCode: incident.causeCode,
        failingRegions: incident.failingRegions,
        /* While it is failing; a recovery or an acknowledgement needs no timing. */
        timing:
          kind === "resolved" || kind === "acknowledged"
            ? null
            : describeEvidenceTiming(incident.evidence),
        monitorName: ctx.monitor?.name ?? null,
        startedAt: incident.startedAt,
        resolvedAt: incident.resolvedAt,
        durationSeconds: incident.durationSeconds,
        url: `${deps.webOrigin}/w/${ctx.workspaceId}/incidents/${incident.number}`,
      },
      actor,
      at: clock.now().toISOString(),
      explanation: explanationFor(kind, ctx),
    };
  }

  /* Failure alerts carry the explainer's cause and first checks (§4 pillar 2). */
  function explanationFor(kind: AlertEventKind, ctx: AlertContext): AlertEvent["explanation"] {
    const { incident } = ctx;
    if (kind === "resolved" || kind === "acknowledged") return null;
    const e = explainIncident(
      incident,
      ctx.monitor ? { target: ctx.monitor.target, regionCount: ctx.monitor.regionCount } : null,
      ctx.recentDeploy,
    );
    if (e === null) return null;
    return { headline: e.headline, detail: e.detail, nextSteps: e.nextSteps.slice(0, 3) };
  }

  const notifyJob = (
    d: Pick<DeliveryRow, "id" | "maxAttempts" | "backoffMs" | "attempts" | "dueAt">,
    suffix?: string,
  ) => {
    const delayMs = d.dueAt === null ? 0 : d.dueAt.getTime() - clock.now().getTime();
    return deps.enqueueNotify(d.id, {
      jobId: suffix === undefined ? buildJobId("notify", d.id) : buildJobId("notify", d.id, suffix),
      attempts: Math.max(1, d.maxAttempts - d.attempts),
      backoffMs: d.backoffMs,
      ...(delayMs > 0 ? { delayMs } : {}),
    });
  };

  const reminderJob = (incidentId: string, dueAt: number) =>
    deps.enqueueTimer(
      { kind: "reminder", incidentId, dueAt },
      {
        jobId: buildJobId("timer", "reminder", incidentId, dueAt),
        delayMs: Math.max(0, dueAt - clock.now().getTime()),
      },
    );

  const escalateJob = (incidentId: string, step: number, dueAt: number) =>
    deps.enqueueTimer(
      { kind: "escalate", incidentId, step, dueAt },
      {
        jobId: buildJobId("timer", "escalate", incidentId, step, dueAt),
        delayMs: Math.max(0, dueAt - clock.now().getTime()),
      },
    );

  const totalSteps = (row: Pick<EscalationRow, "steps" | "repeat">) =>
    row.steps.length * (row.repeat + 1);

  const toEscalation = (row: EscalationRow): IncidentEscalationView => ({
    policyName: row.policyName,
    stepsRun: row.nextStep,
    totalSteps: totalSteps(row),
    nextStepAt:
      row.finishedAt !== null || row.nextDueAt === null ? null : row.nextDueAt.toISOString(),
    finished: row.finishedAt === null ? null : (row.finishedReason ?? "exhausted"),
  });

  /* Pages everyone a step names; returns who was reached, for the timeline. */
  async function runStep(row: EscalationRow, ctx: AlertContext, step: number): Promise<string[]> {
    const definition = row.steps[step % row.steps.length];
    if (definition === undefined) return [];
    const scope = system(ctx.workspaceId);
    const eventKey = `escalation.${row.incidentId}.${step}`;
    const members = await deps.workspaces.listMembers(scope);
    const nameOf = (userId: string) => members.find((m) => m.userId === userId)?.name ?? null;
    const reached: string[] = [];
    const userIds = new Set<string>();
    const channelIds: string[] = [];
    for (const target of definition.targets) {
      if (target.type === "user") userIds.add(target.id);
      else if (target.type === "channel") channelIds.push(target.id);
      else {
        const onCall = await deps.oncall?.whoIsOnCall(scope, target.id, clock.now());
        if (onCall !== undefined) userIds.add(onCall);
      }
    }
    for (const userId of userIds) {
      await service.notifyUser({ incidentId: row.incidentId, eventKey, userId });
      const name = nameOf(userId);
      if (name !== null) reached.push(name);
    }
    const channels = await deps.channels.existing(scope, channelIds);
    const planned = await repo.insertDeliveries(
      deps.db,
      channels.map((c) => {
        const retry = deps.channels.retryPolicy(c.type);
        return {
          id: deps.newId(),
          workspaceId: ctx.workspaceId,
          incidentId: row.incidentId,
          eventKey,
          destinationKey: `channel:${c.id}`,
          channelId: c.id,
          kind: "triggered" as const,
          actorName: null,
          maxAttempts: retry?.attempts ?? NOTIFY_ATTEMPTS,
          backoffMs: retry?.backoffMs ?? NOTIFY_BACKOFF_MS,
        };
      }),
    );
    for (const d of planned) await notifyJob(d);
    reached.push(...channels.map((c) => c.name));
    return reached;
  }

  /* The first reminder slot (startedAt + k·N) strictly after `after`. */
  const nextSlot = (startedAt: number, everyMs: number, after: number) =>
    startedAt + (Math.floor(Math.max(0, after - startedAt) / everyMs) + 1) * everyMs;

  /* Emails workspace admins about a failing channel, at most once an hour per workspace. */
  async function sendFallback(
    channel: ChannelSummary,
    error: string,
    incidentTitle?: string,
  ): Promise<boolean> {
    const scope = system(channel.workspaceId);
    const now = clock.now().getTime();
    const hourStart = new Date(now - (now % HOUR_MS));
    const [members, workspaceName] = await Promise.all([
      deps.workspaces.listMembers(scope),
      deps.workspaces.workspaceName(scope),
    ]);
    const admins = members.filter((m) => m.role === "owner" || m.role === "admin");
    return deps.db.transaction(async (tx) => {
      if (!(await repo.claimFallbackHour(tx, channel.workspaceId, hourStart))) return false;
      for (const admin of admins) {
        await deps.outbox.emit(
          tx,
          "email.requested",
          {
            template: "channel-failing",
            to: admin.email,
            data: {
              workspaceName,
              channelName: channel.name,
              channelType: CHANNEL_LABELS[channel.type],
              error,
              url: `${deps.webOrigin}/w/${channel.workspaceId}/integrations`,
              ...(incidentTitle === undefined ? {} : { incidentTitle }),
            },
            idempotencyKey: `fallback.${channel.workspaceId}.${hourStart.getTime()}.${admin.userId}`,
          },
          { workspaceId: channel.workspaceId },
        );
      }
      return true;
    });
  }

  const service: AlertingService = {
    async listPolicies(scope) {
      /* workspace.created normally creates it; this covers workspaces from before alerting. */
      await service.ensureDefaultPolicy(scope.workspaceId);
      return (await repo.listPolicies(deps.db, scope)).map(toPolicy);
    },

    async createPolicy(scope, input) {
      const rules = await checkChannels(scope, alertPolicyRulesSchema.parse(input.rules));
      const created = await repo.insertPolicy(deps.db, scope, {
        id: deps.newId(),
        name: input.name,
        isDefault: false,
        rules,
      });
      if (created === undefined) throw new ConflictError("The alert policy couldn't be created.");
      return toPolicy(created);
    },

    async updatePolicy(scope, id, input) {
      const patch: Partial<Pick<AlertPolicyRow, "name" | "rules">> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.rules !== undefined) {
        const current = await repo.findPolicy(deps.db, scope, id);
        if (current === undefined) throw new NotFoundError("Alert policy not found.");
        patch.rules = await checkChannels(
          scope,
          alertPolicyRulesSchema.parse(input.rules),
          current.rules.channelIds,
        );
      }
      const row = await repo.updatePolicy(deps.db, scope, id, patch);
      if (row === undefined) throw new NotFoundError("Alert policy not found.");
      return toPolicy(row);
    },

    async deletePolicy(scope, id) {
      const policy = await repo.findPolicy(deps.db, scope, id);
      if (policy === undefined) throw new NotFoundError("Alert policy not found.");
      if (policy.isDefault) throw new ConflictError("The default alert policy can't be deleted.");
      await repo.deletePolicy(deps.db, scope, id);
    },

    async routeToDefault(scope, channelId) {
      const [channel] = await deps.channels.existing(scope, [channelId]);
      if (channel === undefined) throw new NotFoundError("Channel not found.");
      await service.ensureDefaultPolicy(scope.workspaceId);
      return deps.db.transaction(async (tx) => {
        const policy = await repo.findDefaultPolicy(tx, scope, true);
        if (policy === undefined) throw new NotFoundError("Alert policy not found.");
        /* Also forget channels deleted since they were added. */
        const live = (await checkChannels(scope, policy.rules, policy.rules.channelIds)).channelIds;
        if (live.includes(channelId)) return toPolicy(policy);
        if (live.length >= MAX_POLICY_CHANNELS) {
          throw new ValidationError(
            `An alert policy can send to at most ${MAX_POLICY_CHANNELS} channels.`,
          );
        }
        const row = await repo.updatePolicy(tx, scope, policy.id, {
          rules: { ...policy.rules, channelIds: [...live, channelId] },
        });
        return toPolicy(row ?? policy);
      });
    },

    async ensureDefaultPolicy(workspaceId) {
      const created = await repo.insertPolicy(deps.db, system(workspaceId), {
        id: deps.newId(),
        name: "Default",
        isDefault: true,
        rules: DEFAULT_RULES,
      });
      return created !== undefined;
    },

    async planIncidentEvent({ kind, incidentId, eventKey, actorUserId }) {
      const ctx = await deps.incidents.alertContext(incidentId);
      if (ctx === undefined) return 0;
      const policy = await policyFor(ctx);
      if (policy === undefined || !policy.rules.events[kind]) return 0;
      /* The policy says which channels to ask; each channel's own rules say what it accepts. */
      const channels = (
        await deps.channels.existing(system(ctx.workspaceId), policy.rules.channelIds)
      ).filter((c) =>
        channelAccepts(
          c.rules,
          kind,
          ctx.incident.severity,
          CHANNEL_CAPABILITIES[c.type].followUps === "sync",
        ),
      );
      if (channels.length === 0) return 0;

      const actorId = actorUserId ?? (kind === "resolved" ? ctx.incident.resolvedBy : null) ?? null;
      const actorName = await memberName(ctx.workspaceId, actorId);
      const planned = await repo.insertDeliveries(
        deps.db,
        channels.map((c) => {
          const retry = deps.channels.retryPolicy(c.type);
          return {
            id: deps.newId(),
            workspaceId: ctx.workspaceId,
            incidentId,
            eventKey,
            destinationKey: `channel:${c.id}`,
            channelId: c.id,
            kind,
            actorName,
            maxAttempts: retry?.attempts ?? NOTIFY_ATTEMPTS,
            backoffMs: retry?.backoffMs ?? NOTIFY_BACKOFF_MS,
          };
        }),
      );
      for (const d of planned) await notifyJob(d);
      return planned.length;
    },

    async startEscalation(incidentId) {
      if (deps.oncall === undefined) return false;
      const ctx = await deps.incidents.alertContext(incidentId);
      if (ctx === undefined || ctx.incident.status !== "triggered") return false;
      const policyId = (await policyFor(ctx))?.rules.escalationPolicyId ?? null;
      if (policyId === null) return false;
      const policy = await deps.oncall.escalationPolicy(system(ctx.workspaceId), policyId);
      const first = policy?.steps[0];
      if (policy === undefined || first === undefined) return false;
      const dueAt = new Date(clock.now().getTime() + first.delayMinutes * 60_000);
      const row = await repo.insertEscalation(deps.db, {
        incidentId,
        workspaceId: ctx.workspaceId,
        policyId: policy.id,
        policyName: policy.name,
        steps: policy.steps,
        repeat: policy.repeat,
        nextDueAt: dueAt,
      });
      if (row === undefined) return false;
      await escalateJob(incidentId, 0, dueAt.getTime());
      return true;
    },

    async escalationDue(incidentId, step, dueAt) {
      const row = await repo.findEscalation(deps.db, incidentId);
      /* An older job for a step that already ran, or one replaced by "escalate now". */
      if (
        row === undefined ||
        row.finishedAt !== null ||
        row.nextStep !== step ||
        row.nextDueAt === null ||
        row.nextDueAt.getTime() !== dueAt
      ) {
        return "stale";
      }
      const ctx = await deps.incidents.alertContext(incidentId);
      const status = ctx?.incident.status ?? "resolved";
      const stop = (reason: "acknowledged" | "resolved" | "exhausted") =>
        repo.advanceEscalation(deps.db, incidentId, step, {
          nextStep: step,
          nextDueAt: null,
          finishedAt: clock.now(),
          finishedReason: reason,
        });
      /* Correctness never depends on removing jobs: the job runs and finds nothing to do (§9.5). */
      if (ctx === undefined || status === "resolved" || status === "acknowledged") {
        await stop(status === "acknowledged" ? "acknowledged" : "resolved");
        return "stopped";
      }
      if (status === "snoozed") {
        const until =
          ctx.incident.snoozedUntil === null
            ? clock.now().getTime() + 60_000
            : Date.parse(ctx.incident.snoozedUntil);
        const moved = await repo.advanceEscalation(deps.db, incidentId, step, {
          nextStep: step,
          nextDueAt: new Date(until),
          finishedAt: null,
          finishedReason: null,
        });
        if (moved !== undefined) await escalateJob(incidentId, step, until);
        return "waiting";
      }

      /* Paging is idempotent (one delivery per event and destination), so a re-run is harmless. */
      const reached = await runStep(row, ctx, step);
      const next = step + 1;
      const last = next >= totalSteps(row);
      const nextDelay = row.steps[next % row.steps.length]?.delayMinutes ?? 0;
      const nextDueAt = last ? null : new Date(clock.now().getTime() + nextDelay * 60_000);
      const advanced = await repo.advanceEscalation(deps.db, incidentId, step, {
        nextStep: next,
        nextDueAt,
        finishedAt: last ? clock.now() : null,
        finishedReason: last ? "exhausted" : null,
      });
      if (advanced === undefined) return "stale";
      await deps.incidents.addSystemEvent(incidentId, "escalated", {
        policyName: row.policyName,
        step: (step % row.steps.length) + 1,
        round: Math.floor(step / row.steps.length) + 1,
        reached,
      });
      if (nextDueAt !== null) await escalateJob(incidentId, next, nextDueAt.getTime());
      return "ran";
    },

    async escalateNow(scope, incidentId) {
      const row = await repo.findEscalation(deps.db, incidentId);
      if (row === undefined || row.workspaceId !== scope.workspaceId) {
        throw new ConflictError("This incident has no escalation policy.");
      }
      if (row.finishedAt !== null || row.nextDueAt === null) {
        throw new ConflictError(
          row.finishedReason === "exhausted"
            ? "Every step of the escalation policy has already run."
            : "The escalation has stopped: someone has taken the incident or it is resolved.",
        );
      }
      const now = clock.now();
      const moved = await repo.advanceEscalation(deps.db, incidentId, row.nextStep, {
        nextStep: row.nextStep,
        nextDueAt: now,
        finishedAt: null,
        finishedReason: null,
      });
      if (moved !== undefined) await service.escalationDue(incidentId, row.nextStep, now.getTime());
      const after = await repo.findEscalation(deps.db, incidentId);
      return toEscalation(after ?? row);
    },

    async escalationOf(scope, incidentId) {
      const row = await repo.findEscalation(deps.db, incidentId);
      return row === undefined || row.workspaceId !== scope.workspaceId ? null : toEscalation(row);
    },

    async recoverEscalations() {
      const open = await repo.openEscalations(deps.db, SWEEP_BATCH);
      for (const row of open) {
        if (row.nextDueAt !== null) {
          await escalateJob(row.incidentId, row.nextStep, row.nextDueAt.getTime());
        }
      }
      return open.length;
    },

    async notifyUser({ incidentId, eventKey, userId }) {
      if (deps.contacts === undefined) return 0;
      const ctx = await deps.incidents.alertContext(incidentId);
      if (ctx === undefined || ctx.incident.status !== "triggered") return 0;
      const steps = await deps.contacts.fanOut(
        system(ctx.workspaceId),
        userId,
        urgencyOf(ctx.incident.severity),
        clock.now(),
      );
      const planned = await repo.insertDeliveries(
        deps.db,
        steps.map((step) => ({
          id: deps.newId(),
          workspaceId: ctx.workspaceId,
          incidentId,
          eventKey,
          destinationKey: `user:${userId}:method:${step.contactMethodId}`,
          channelId: null,
          userId,
          contactMethodId: step.contactMethodId,
          contactType: step.type,
          contactAddress: step.address,
          dueAt: step.delayMinutes === 0 ? null : step.dueAt,
          kind: "triggered" as const,
          actorName: null,
          /* A text or a call that arrives late is noise; they retry like their channels do. */
          maxAttempts: deps.channels.retryPolicy(step.type)?.attempts ?? NOTIFY_ATTEMPTS,
          backoffMs: deps.channels.retryPolicy(step.type)?.backoffMs ?? NOTIFY_BACKOFF_MS,
        })),
      );
      for (const d of planned) await notifyJob(d);
      return planned.length;
    },

    async deliver(deliveryId) {
      const delivery = await repo.claim(deps.db, deliveryId);
      if (delivery === undefined) return "skipped";
      const finish = (patch: Parameters<AlertingRepository["finish"]>[2]) =>
        repo.finish(deps.db, deliveryId, patch);

      const ctx = await deps.incidents.alertContext(delivery.incidentId);
      if (ctx === undefined) {
        await finish({ status: "skipped", error: "The incident or channel no longer exists." });
        return "skipped";
      }
      const workspaceName = await deps.workspaces.workspaceName(system(ctx.workspaceId));
      const event = eventFor(delivery.kind, ctx, workspaceName, delivery.actorName);

      /* To a person, through one of their own contact methods. */
      if (delivery.contactType !== null && delivery.contactAddress !== null) {
        if (delivery.kind === "triggered" && ctx.incident.status !== "triggered") {
          await finish({
            status: "skipped",
            error: `Not needed: the incident was ${ctx.incident.status} before this step was due.`,
          });
          return "skipped";
        }
        try {
          const { providerRef } = await deps.channels.deliverDirect({
            type: delivery.contactType,
            address: delivery.contactAddress,
            event,
            idempotencyKey: `delivery.${delivery.id}`,
          });
          await finish({ status: "sent", providerRef, error: null, sentAt: clock.now() });
          return "sent";
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const permanent = err instanceof ChannelDeliveryError && err.permanent;
          if (!permanent && delivery.attempts < delivery.maxAttempts) {
            await finish({ status: "retrying", error: message });
            throw new RetryDeliveryError(message);
          }
          await finish({ status: "failed", error: message });
          /* A paid text or call that never went out gives its credits back. */
          await deps.credits
            ?.refundCharge(system(ctx.workspaceId), `delivery.${delivery.id}`)
            .catch((refundErr: unknown) =>
              deps.logger.error(
                { deliveryId, err: refundErr },
                "refunding an unsent message failed",
              ),
            );
          deps.logger.warn(
            { deliveryId, userId: delivery.userId, attempts: delivery.attempts, err: message },
            "delivery to a person failed permanently",
          );
          await deps.incidents.addSystemEvent(delivery.incidentId, "delivery_failed", {
            channelId: null,
            channelName: await personLabel(ctx.workspaceId, delivery),
            kind: delivery.kind,
            error: message,
          });
          return "failed";
        }
      }
      if (delivery.channelId === null) {
        await finish({ status: "skipped", error: "The incident or channel no longer exists." });
        return "skipped";
      }

      try {
        const { providerRef, skipped } = await deps.channels.deliver({
          channelId: delivery.channelId,
          event,
          idempotencyKey: `delivery.${delivery.id}`,
        });
        if (skipped !== undefined) {
          await finish({ status: "skipped", error: skipped });
          return "skipped";
        }
        await finish({ status: "sent", providerRef, error: null, sentAt: clock.now() });
        return "sent";
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const permanent = err instanceof ChannelDeliveryError && err.permanent;
        if (!permanent && delivery.attempts < delivery.maxAttempts) {
          await finish({ status: "retrying", error: message });
          throw new RetryDeliveryError(message);
        }

        await finish({ status: "failed", error: message });
        /* A paid message that never went out gives its credits back. */
        await deps.credits
          ?.refundCharge(system(ctx.workspaceId), `delivery.${delivery.id}`)
          .catch((refundErr: unknown) =>
            deps.logger.error({ deliveryId, err: refundErr }, "refunding an unsent message failed"),
          );
        deps.logger.warn(
          { deliveryId, channelId: delivery.channelId, attempts: delivery.attempts, err: message },
          "delivery failed permanently",
        );
        await deps.channels.markFailing(delivery.channelId);
        const channel = await deps.channels.summary(delivery.channelId);
        await deps.incidents.addSystemEvent(delivery.incidentId, "delivery_failed", {
          channelId: delivery.channelId,
          channelName: channel?.name ?? null,
          kind: delivery.kind,
          error: message,
        });
        if (channel !== undefined) await sendFallback(channel, message, ctx.incident.title);
        return "failed";
      }
    },

    async scheduleReminders(incidentId) {
      const ctx = await deps.incidents.alertContext(incidentId);
      const minutes = ctx?.monitor?.reminderMinutes;
      if (ctx === undefined || !minutes || ctx.incident.status === "resolved") return false;
      const startedAt = Date.parse(ctx.incident.startedAt);
      await reminderJob(incidentId, nextSlot(startedAt, minutes * 60_000, clock.now().getTime()));
      return true;
    },

    async reminderDue(incidentId, dueAt) {
      const ctx = await deps.incidents.alertContext(incidentId);
      const minutes = ctx?.monitor?.reminderMinutes;
      if (ctx === undefined || !minutes || ctx.incident.status === "resolved") return 0;
      const everyMs = minutes * 60_000;
      const startedAt = Date.parse(ctx.incident.startedAt);
      const now = clock.now().getTime();

      const snoozedUntil =
        ctx.incident.snoozedUntil === null ? 0 : Date.parse(ctx.incident.snoozedUntil);
      if (snoozedUntil > now) {
        await reminderJob(incidentId, nextSlot(startedAt, everyMs, snoozedUntil));
        return 0;
      }
      const planned = await service.planIncidentEvent({
        kind: "reminder",
        incidentId,
        eventKey: `reminder.${incidentId}.${dueAt}`,
      });
      await reminderJob(incidentId, nextSlot(startedAt, everyMs, Math.max(dueAt, now)));
      return planned;
    },

    async onChannelHealth(channelId, status) {
      if (status !== "failing") return;
      const channel = await deps.channels.summary(channelId);
      if (channel !== undefined) {
        await sendFallback(channel, channel.lastError ?? "Deliveries keep failing.");
      }
    },

    async sendTest(scope, channelId) {
      const [channel] = await deps.channels.existing(scope, [channelId]);
      if (channel === undefined) throw new NotFoundError("Channel not found.");
      const workspaceName = await deps.workspaces.workspaceName(scope);
      const now = clock.now().toISOString();
      try {
        await deps.channels.deliver({
          channelId,
          idempotencyKey: `test.${deps.newId()}`,
          event: {
            kind: "test",
            workspace: { id: scope.workspaceId, name: workspaceName },
            incident: {
              id: channelId,
              number: 0,
              title: "Test alert",
              severity: "low",
              status: "resolved",
              causeCode: null,
              failingRegions: [],
              monitorName: null,
              startedAt: now,
              resolvedAt: now,
              durationSeconds: 0,
              url: `${deps.webOrigin}/w/${scope.workspaceId}/integrations`,
            },
            actor: null,
            at: now,
            explanation: null,
          },
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async deliveryLog(scope, incidentId) {
      const rows = await repo.deliveriesForIncidentScoped(deps.db, scope, incidentId);
      const ids = [...new Set(rows.flatMap((r) => (r.channelId ? [r.channelId] : [])))];
      const channels = new Map((await deps.channels.existing(scope, ids)).map((c) => [c.id, c]));
      const members = new Map(
        rows.some((r) => r.userId !== null)
          ? (await deps.workspaces.listMembers(scope)).map((m) => [m.userId, m.name] as const)
          : [],
      );
      return rows.map((row) => {
        const channel = row.channelId ? channels.get(row.channelId) : undefined;
        /* A delivery to a person shows their name where a channel's would be. */
        const person = row.userId === null ? null : (members.get(row.userId) ?? "A former member");
        return {
          ...toDelivery(row),
          channelName: channel?.name ?? person,
          channelType: channel?.type ?? row.contactType,
          createdAt: row.createdAt.toISOString(),
        };
      });
    },

    async deliveriesFor(incidentId) {
      return (await repo.deliveriesForIncident(deps.db, incidentId)).map(toDelivery);
    },

    async recoverDeliveries() {
      const stale = await repo.unfinished(
        deps.db,
        new Date(clock.now().getTime() - STALE_DELIVERY_MS),
        SWEEP_BATCH,
      );
      /*
       * One recovery job ID per attempt: while a recovery job is still queued (a backlog, not a loss),
       * BullMQ ignores the duplicate add, so the minutely sweep can't pile up jobs. A job that ran and
       * failed raised `attempts`, so the next recovery gets a fresh ID.
       */
      for (const d of stale) await notifyJob(d, `r${d.attempts}`);
      /*
       * Delayed deliveries that aren't due yet get their delayed job again under its usual ID: a job
       * that is still queued makes this a no-op, a lost one is replaced.
       */
      for (const d of await repo.scheduled(deps.db, clock.now(), SWEEP_BATCH)) await notifyJob(d);
      return stale.length;
    },

    async recoverReminders() {
      let count = 0;
      let afterId: string | undefined;
      for (;;) {
        const ids = await deps.incidents.openIncidentIds({
          limit: SWEEP_BATCH,
          ...(afterId === undefined ? {} : { afterId }),
        });
        for (const id of ids) if (await service.scheduleReminders(id)) count += 1;
        if (ids.length < SWEEP_BATCH) return count;
        afterId = ids.at(-1);
      }
    },
  };
  return service;
}
