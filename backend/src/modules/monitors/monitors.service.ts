/*
 * Monitor configuration rules (PRODUCT.md §6.1–6.2, §5 limits). Every write runs in one transaction
 * that also appends to the global change feed (probes sync from it) and emits the monitor event.
 */
import {
  createMonitorSchema,
  cronProblem,
  monitorConfigSchema,
  monitorSettingsSchema,
  type CreateMonitorInput,
  type MonitorConfig,
  type MonitorSettings,
  type MonitorUsage,
  isPrivateRegion,
  PRIVATE_PROBE_MONITOR_TYPES,
} from "@app/shared";
import type { Clock } from "../../core/clock.js";
import {
  ConflictError,
  NotFoundError,
  QuotaExceededError,
  ValidationError,
} from "../../core/errors.js";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import type { PlanLimits } from "../../config/plans.js";
import type { TokenCipher } from "../../infra/crypto.js";
import { withAdvisoryLock } from "../../infra/db/lock.js";
import type { Db, DbOrTx } from "../../infra/db/index.js";
import type { Outbox } from "../../infra/outbox/index.js";
import type { MonitorGroupRow, MonitorPolicies, MonitorRow } from "./schema/monitors.js";
import type { ListFilters, MonitorsRepository } from "./monitors.repository.js";
import {
  applySecrets,
  extractSecrets,
  hasUnresolvedMask,
  type MonitorSecrets,
} from "./types/secrets.js";

export interface MonitorView {
  id: string;
  type: MonitorConfig["type"];
  name: string;
  config: MonitorConfig;
  intervalSeconds: number;
  timeoutMs: number;
  regions: string[];
  minFailingRegions: number;
  alertOnRegionalIssue: boolean;
  recoverySuccesses: number;
  degradedLatencyMs: number | null;
  degradedAfterChecks: number;
  upsideDown: boolean;
  reminderMinutes: number | null;
  sloTarget: number;
  severity: "critical" | "high" | "low";
  tags: string[];
  groupId: string | null;
  parentId: string | null;
  alertPolicyId: string | null;
  paused: boolean;
  pausedReason: "user" | "plan_limit" | null;
  runbookUrl: string | null;
  notes: string | null;
  publicName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateMonitorInput {
  settings?: Partial<MonitorSettings>;
  config?: unknown;
}

export interface MonitorGroupView {
  id: string;
  name: string;
  /* Failures in the group within 15 seconds of each other go out as one message. */
  groupAlerts: boolean;
  createdAt: string;
}

/* A monitor as probes receive it: full config with secrets, only over the signed probe API. */
export interface MonitorForProbe {
  id: string;
  workspaceId: string;
  config: MonitorConfig;
  intervalSeconds: number;
  timeoutMs: number;
  regions: string[];
  configSeq: number;
  paused: boolean;
}

/* What detection needs to judge results (§9.2). Carries no secrets. */
export interface MonitorForDetection {
  id: string;
  workspaceId: string;
  name: string;
  type: MonitorConfig["type"];
  regions: string[];
  intervalSeconds: number;
  severity: MonitorSettings["severity"];
  paused: boolean;
  parentId: string | null;
  /* The monitor's group, for grouped alerts (§9.6). */
  group: { id: string; name: string; groupAlerts: boolean } | null;
  alertPolicyId: string | null;
  policies: MonitorPolicies;
  /* Hostname the monitor checks (never credentials or paths), for explanations. */
  target: string | null;
}

export interface MonitorsService {
  create(scope: WorkspaceScope, input: CreateMonitorInput): Promise<MonitorView>;
  get(scope: WorkspaceScope, id: string): Promise<MonitorView>;
  list(
    scope: WorkspaceScope,
    filters: ListFilters,
  ): Promise<{ data: MonitorView[]; nextCursor: string | null }>;
  update(scope: WorkspaceScope, id: string, input: UpdateMonitorInput): Promise<MonitorView>;
  setPaused(scope: WorkspaceScope, id: string, paused: boolean): Promise<MonitorView>;
  /* The workspace's plan limits (other modules ask here instead of calling billing themselves). */
  planLimits(scope: WorkspaceScope): Promise<PlanLimits>;
  /* How many monitors run in each of the given regions (a private probe's monitors). */
  countByRegion(scope: WorkspaceScope, regions: string[]): Promise<Map<string, number>>;
  /* Active monitors against the plan, for usage meters. */
  usage(scope: WorkspaceScope): Promise<MonitorUsage>;
  /*
   * Brings the workspace in line with its plan after the plan changed (PRODUCT.md §5: downgrades
   * pause, never delete). Over the limit: the newest monitors are paused with reason `plan_limit`.
   * Room again: monitors paused that way resume, oldest first. Checks faster than the plan allows are
   * slowed to the plan's minimum and extra regions are dropped. Idempotent.
   */
  enforcePlanLimits(scope: WorkspaceScope): Promise<PlanEnforcement>;
  delete(scope: WorkspaceScope, id: string): Promise<void>;
  listTags(scope: WorkspaceScope): Promise<Array<{ id: string; name: string }>>;
  createGroup(
    scope: WorkspaceScope,
    name: string,
    groupAlerts?: boolean,
  ): Promise<MonitorGroupView>;
  listGroups(scope: WorkspaceScope): Promise<MonitorGroupView[]>;
  /* Renames a group; `groupAlerts` changes only when given. */
  renameGroup(
    scope: WorkspaceScope,
    id: string,
    name: string,
    groupAlerts?: boolean,
  ): Promise<MonitorGroupView>;
  deleteGroup(scope: WorkspaceScope, id: string): Promise<void>;
  /* Change feed for probes (§7.6). */
  changesSince(
    afterSeq: number,
    limit: number,
  ): Promise<{
    cursor: number;
    upserts: MonitorForProbe[];
    deletes: string[];
  }>;
  latestSeq(): Promise<number>;
  /* Active (unpaused) monitors for probe full syncs, paged by id. System-level: no tenant scope. */
  /*
   * `nextAfterId` pages over the raw rows (null on the last page): monitors skipped for undecryptable
   * secrets must not make a page look like the last one.
   */
  listForProbes(options: {
    afterId?: string;
    limit: number;
  }): Promise<{ monitors: MonitorForProbe[]; nextAfterId: string | null }>;
  /* Specific monitors for probe tasks. System-level: no tenant scope. */
  getForProbes(ids: string[]): Promise<MonitorForProbe[]>;
  /* Monitors of the given types with their configs, paged by ID. System-level: no tenant scope. */
  listByType(
    types: MonitorConfig["type"][],
    options: { afterId?: string; limit: number },
  ): Promise<{ monitors: MonitorForProbe[]; nextAfterId: string | null }>;
  /* When the monitor was created or edited in [from, to) (paused/resumed count too). */
  changeTimes(scope: WorkspaceScope, id: string, from: Date, to: Date): Promise<Date[]>;
  /* Settings detection evaluates against. System-level: no tenant scope. */
  getForDetection(ids: string[]): Promise<MonitorForDetection[]>;
}

export interface PlanEnforcement {
  paused: number;
  resumed: number;
  adjusted: number;
}

export interface MonitorsServiceDeps {
  db: Db;
  repository: MonitorsRepository;
  outbox: Outbox;
  clock: Clock;
  cipher: TokenCipher;
  newId: () => string;
  limits: (scope: WorkspaceScope) => Promise<PlanLimits>;
  /* Reports monitors skipped for probes because their secrets can't be decrypted. */
  onSecretError?: (monitorId: string, err: unknown) => void;
  /* The workspace's private probe locations; a monitor can't be put on anyone else's. */
  privateRegions?: ((scope: WorkspaceScope) => Promise<string[]>) | undefined;
}

const secretsAad = (monitorId: string) => `monitor:${monitorId}`;

function settingsOf(row: MonitorRow, tags: string[]): MonitorSettings {
  return {
    name: row.name,
    intervalSeconds: row.intervalS,
    timeoutMs: row.timeoutMs,
    regions: row.regions as MonitorSettings["regions"],
    minFailingRegions: row.policies.minFailingRegions,
    alertOnRegionalIssue: row.policies.alertOnRegionalIssue ?? false,
    recoverySuccesses: row.policies.recoverySuccesses,
    degradedLatencyMs: row.policies.degradedLatencyMs,
    degradedAfterChecks: row.policies.degradedAfterChecks,
    upsideDown: row.policies.upsideDown,
    sloTarget: row.policies.sloTarget ?? 99.9,
    reminderMinutes: row.policies.reminderMinutes,
    severity: row.severity,
    tags,
    groupId: row.groupId ?? undefined,
    parentId: row.parentId ?? undefined,
    alertPolicyId: row.alertPolicyId ?? undefined,
    runbookUrl: row.runbookUrl ?? undefined,
    notes: row.notes ?? undefined,
    publicName: row.publicName ?? undefined,
  };
}

const toGroup = (row: MonitorGroupRow): MonitorGroupView => ({
  id: row.id,
  name: row.name,
  groupAlerts: row.groupAlerts,
  createdAt: row.createdAt.toISOString(),
});

function toView(row: MonitorRow, tags: string[]): MonitorView {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    config: row.config,
    intervalSeconds: row.intervalS,
    timeoutMs: row.timeoutMs,
    regions: row.regions,
    minFailingRegions: row.policies.minFailingRegions,
    alertOnRegionalIssue: row.policies.alertOnRegionalIssue ?? false,
    recoverySuccesses: row.policies.recoverySuccesses,
    degradedLatencyMs: row.policies.degradedLatencyMs ?? null,
    degradedAfterChecks: row.policies.degradedAfterChecks,
    upsideDown: row.policies.upsideDown,
    reminderMinutes: row.policies.reminderMinutes ?? null,
    sloTarget: row.policies.sloTarget ?? 99.9,
    severity: row.severity,
    tags,
    groupId: row.groupId,
    parentId: row.parentId,
    alertPolicyId: row.alertPolicyId,
    paused: row.paused,
    pausedReason: row.pausedReason ?? null,
    runbookUrl: row.runbookUrl,
    notes: row.notes,
    publicName: row.publicName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function columnsFrom(settings: MonitorSettings) {
  return {
    name: settings.name,
    intervalS: settings.intervalSeconds,
    timeoutMs: settings.timeoutMs,
    regions: settings.regions,
    policies: {
      minFailingRegions: settings.minFailingRegions,
      alertOnRegionalIssue: settings.alertOnRegionalIssue,
      recoverySuccesses: settings.recoverySuccesses,
      degradedLatencyMs: settings.degradedLatencyMs,
      degradedAfterChecks: settings.degradedAfterChecks,
      upsideDown: settings.upsideDown,
      reminderMinutes: settings.reminderMinutes,
      sloTarget: settings.sloTarget,
    },
    severity: settings.severity,
    alertPolicyId: settings.alertPolicyId ?? null,
    groupId: settings.groupId ?? null,
    parentId: settings.parentId ?? null,
    runbookUrl: settings.runbookUrl ?? null,
    notes: settings.notes ?? null,
    publicName: settings.publicName ?? null,
  };
}

function formatInterval(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
}

export function createMonitorsService(deps: MonitorsServiceDeps): MonitorsService {
  const { db, repository: repo, cipher } = deps;

  function decryptSecrets(row: MonitorRow): MonitorSecrets | null {
    if (row.secretsEnc === null) return null;
    return JSON.parse(cipher.decrypt(row.secretsEnc, secretsAad(row.id))) as MonitorSecrets;
  }

  function encryptSecrets(id: string, secrets: MonitorSecrets | null): string | null {
    return secrets === null ? null : cipher.encrypt(JSON.stringify(secrets), secretsAad(id));
  }

  async function checkLimits(
    tx: DbOrTx,
    scope: WorkspaceScope,
    type: MonitorConfig["type"],
    settings: MonitorSettings,
    options: { countsTowardLimit: boolean; excludeId?: string },
  ): Promise<void> {
    const limits = await deps.limits(scope);
    if (settings.intervalSeconds < limits.minIntervalSeconds) {
      throw new QuotaExceededError(
        `Your plan checks at most every ${formatInterval(limits.minIntervalSeconds)}. Upgrade for faster checks.`,
      );
    }
    const privateRegion = settings.regions.find(isPrivateRegion);
    if (PRIVATE_PROBE_MONITOR_TYPES.includes(type) && privateRegion === undefined) {
      throw new ValidationError("This kind of monitor runs on a private probe.", [
        { path: "settings.regions", message: "choose a private probe" },
      ]);
    }
    if (privateRegion !== undefined) {
      const own = (await deps.privateRegions?.(scope)) ?? [];
      if (!own.includes(privateRegion)) {
        throw new ValidationError("That private probe doesn't exist in this workspace.", [
          { path: "settings.regions", message: "unknown private probe" },
        ]);
      }
    }
    if (settings.regions.length > limits.regionsPerMonitor) {
      throw new QuotaExceededError(
        `Your plan allows ${limits.regionsPerMonitor} regions per monitor. Upgrade to check from more regions.`,
      );
    }
    if (!options.countsTowardLimit) return;
    const kind = type === "heartbeat" ? "heartbeat" : "monitor";
    const max = kind === "heartbeat" ? limits.heartbeats : limits.monitors;
    const count = await repo.countByKind(tx, scope, kind, options.excludeId);
    if (count >= max) {
      throw new QuotaExceededError(
        `Your plan allows ${max} active ${kind === "heartbeat" ? "heartbeat monitors" : "monitors"}. Pause or delete one, or upgrade.`,
      );
    }
  }

  async function checkRelations(
    tx: DbOrTx,
    scope: WorkspaceScope,
    settings: MonitorSettings,
    selfId: string,
  ): Promise<void> {
    if (settings.groupId && (await repo.findGroup(tx, scope, settings.groupId)) === undefined) {
      throw new ValidationError("The group doesn't exist.", [
        { path: "settings.groupId", message: "not found" },
      ]);
    }
    if (settings.parentId) {
      if (settings.parentId === selfId) {
        throw new ValidationError("A monitor can't depend on itself.", [
          { path: "settings.parentId", message: "must be another monitor" },
        ]);
      }
      if ((await repo.find(tx, scope, settings.parentId)) === undefined) {
        throw new ValidationError("The parent monitor doesn't exist.", [
          { path: "settings.parentId", message: "not found" },
        ]);
      }
      if ((await repo.ancestorIds(tx, scope, settings.parentId)).includes(selfId)) {
        throw new ConflictError("That parent would create a dependency loop.");
      }
    }
  }

  async function recordChange(
    tx: DbOrTx,
    scope: WorkspaceScope,
    monitorId: string,
    op: "upsert" | "delete",
  ): Promise<number> {
    const seq = await repo.appendChange(tx, { monitorId, workspaceId: scope.workspaceId, op });
    if (op === "upsert") await repo.update(tx, scope, monitorId, { configSeq: seq });
    return seq;
  }

  async function viewOf(tx: DbOrTx, row: MonitorRow): Promise<MonitorView> {
    const tags = (await repo.tagsFor(tx, [row.id])).get(row.id) ?? [];
    return toView(row, tags);
  }

  async function mustFind(tx: DbOrTx, scope: WorkspaceScope, id: string, forUpdate = false) {
    const row = await repo.find(tx, scope, id, forUpdate);
    if (row === undefined) throw new NotFoundError("Monitor not found.");
    return row;
  }

  const service: MonitorsService = {
    async create(scope, input) {
      const parsed = createMonitorSchema.safeParse(input);
      if (!parsed.success)
        throw new ValidationError("The monitor is invalid.", issuesOf(parsed.error));
      const { settings, config } = parsed.data;
      checkSchedule(config);
      const id = deps.newId();

      return withAdvisoryLock(db, scope.workspaceId, async (tx) => {
        await checkLimits(tx, scope, config.type, settings, { countsTowardLimit: true });
        await checkRelations(tx, scope, settings, id);

        const { config: stored, secrets } = extractSecrets(config);
        await repo.insert(tx, {
          id,
          workspaceId: scope.workspaceId,
          type: config.type,
          config: stored,
          secretsEnc: encryptSecrets(id, secrets),
          ...columnsFrom(settings),
        });
        const tagRows = await repo.upsertTags(tx, scope, settings.tags, deps.newId);
        await repo.setMonitorTags(
          tx,
          id,
          tagRows.map((t) => t.id),
        );
        await recordChange(tx, scope, id, "upsert");
        await deps.outbox.emit(
          tx,
          "monitor.created",
          { monitorId: id, name: settings.name },
          { workspaceId: scope.workspaceId },
        );
        return viewOf(tx, await mustFind(tx, scope, id));
      });
    },

    async get(scope, id) {
      return viewOf(db, await mustFind(db, scope, id));
    },

    async list(scope, filters) {
      const rows = await repo.list(scope, { ...filters, limit: filters.limit + 1 });
      const page = rows.slice(0, filters.limit);
      const tagMap = await repo.tagsFor(
        db,
        page.map((r) => r.id),
      );
      return {
        data: page.map((row) => toView(row, tagMap.get(row.id) ?? [])),
        nextCursor: rows.length > filters.limit ? (page.at(-1)?.id ?? null) : null,
      };
    },

    async update(scope, id, input) {
      return withAdvisoryLock(db, scope.workspaceId, async (tx) => {
        const row = await mustFind(tx, scope, id, true);
        const currentTags = (await repo.tagsFor(tx, [id])).get(id) ?? [];

        const settingsResult = monitorSettingsSchema.safeParse({
          ...settingsOf(row, currentTags),
          ...(input.settings ?? {}),
        });
        if (!settingsResult.success) {
          throw new ValidationError(
            "The monitor settings are invalid.",
            issuesOf(settingsResult.error, "settings"),
          );
        }
        const settings = settingsResult.data;

        let config = row.config;
        let secretsEnc = row.secretsEnc;
        if (input.config !== undefined) {
          const configResult = monitorConfigSchema.safeParse(input.config);
          if (!configResult.success) {
            throw new ValidationError(
              "The monitor config is invalid.",
              issuesOf(configResult.error, "config"),
            );
          }
          checkSchedule(configResult.data);
          if (configResult.data.type !== row.type) {
            throw new ValidationError(
              "A monitor's type can't change; create a new monitor instead.",
              [{ path: "config.type", message: `must stay "${row.type}"` }],
            );
          }
          /*
           * Stored secrets stay with the target they were entered for: pointing the monitor somewhere
           * else while keeping masked values would send the secrets to the new target.
           */
          const sameTarget = targetOf(row.config) === targetOf(configResult.data);
          const merged = applySecrets(configResult.data, sameTarget ? decryptSecrets(row) : null);
          if (hasUnresolvedMask(merged)) {
            throw new ValidationError(
              sameTarget
                ? "A masked secret has no stored value; enter it again."
                : "The target changed, so enter the secrets again for the new target.",
              [{ path: "config", message: "masked value without a stored secret" }],
            );
          }
          const split = extractSecrets(merged);
          config = split.config;
          secretsEnc = encryptSecrets(id, split.secrets);
        }

        await checkLimits(tx, scope, row.type, settings, { countsTowardLimit: false });
        await checkRelations(tx, scope, settings, id);

        const updated = await repo.update(tx, scope, id, {
          ...columnsFrom(settings),
          config,
          secretsEnc,
        });
        if (updated === undefined) throw new NotFoundError("Monitor not found.");
        if (input.settings?.tags !== undefined) {
          const tagRows = await repo.upsertTags(tx, scope, settings.tags, deps.newId);
          await repo.setMonitorTags(
            tx,
            id,
            tagRows.map((t) => t.id),
          );
        }
        await recordChange(tx, scope, id, "upsert");
        await deps.outbox.emit(
          tx,
          "monitor.updated",
          { monitorId: id, name: settings.name },
          { workspaceId: scope.workspaceId },
        );
        return viewOf(tx, await mustFind(tx, scope, id));
      });
    },

    async setPaused(scope, id, paused) {
      return withAdvisoryLock(db, scope.workspaceId, async (tx) => {
        const row = await mustFind(tx, scope, id, true);
        if (row.paused === paused) return viewOf(tx, row);
        if (!paused) {
          /* Resuming counts toward the plan limit again. */
          await checkLimits(tx, scope, row.type, settingsOf(row, []), {
            countsTowardLimit: true,
            excludeId: id,
          });
        }
        await repo.update(tx, scope, id, { paused, pausedReason: paused ? "user" : null });
        await recordChange(tx, scope, id, "upsert");
        await deps.outbox.emit(
          tx,
          "monitor.updated",
          { monitorId: id, name: row.name },
          { workspaceId: scope.workspaceId },
        );
        return viewOf(tx, await mustFind(tx, scope, id));
      });
    },

    planLimits: (scope) => deps.limits(scope),
    countByRegion: (scope, regions) => repo.countByRegion(db, scope, regions),

    async usage(scope) {
      const limits = await deps.limits(scope);
      const [monitorCount, heartbeatCount, pausedByPlan] = await Promise.all([
        repo.countByKind(db, scope, "monitor"),
        repo.countByKind(db, scope, "heartbeat"),
        repo.countPausedByPlan(db, scope),
      ]);
      return {
        monitors: { used: monitorCount, limit: limits.monitors },
        heartbeats: { used: heartbeatCount, limit: limits.heartbeats },
        pausedByPlan,
      };
    },

    async enforcePlanLimits(scope) {
      return withAdvisoryLock(db, scope.workspaceId, async (tx) => {
        const limits = await deps.limits(scope);
        const rows = await repo.allForWorkspace(tx, scope);
        const result: PlanEnforcement = { paused: 0, resumed: 0, adjusted: 0 };
        const change = async (row: MonitorRow, patch: Partial<MonitorRow>) => {
          await repo.update(tx, scope, row.id, patch);
          Object.assign(row, patch);
          await recordChange(tx, scope, row.id, "upsert");
          await deps.outbox.emit(
            tx,
            "monitor.updated",
            { monitorId: row.id, name: row.name },
            { workspaceId: scope.workspaceId },
          );
        };

        for (const kind of ["monitor", "heartbeat"] as const) {
          const max = kind === "heartbeat" ? limits.heartbeats : limits.monitors;
          const ofKind = rows.filter((r) => (r.type === "heartbeat") === (kind === "heartbeat"));
          const active = ofKind.filter((r) => !r.paused);
          if (active.length > max) {
            /* The oldest stay active; the user can swap which ones afterwards. */
            for (const row of active.slice(max)) {
              await change(row, { paused: true, pausedReason: "plan_limit" });
              result.paused += 1;
            }
          } else {
            const waiting = ofKind.filter((r) => r.paused && r.pausedReason === "plan_limit");
            for (const row of waiting.slice(0, max - active.length)) {
              await change(row, { paused: false, pausedReason: null });
              result.resumed += 1;
            }
          }
        }

        for (const row of rows) {
          if (row.paused) continue;
          const patch: Partial<MonitorRow> = {};
          if (row.intervalS < limits.minIntervalSeconds) {
            patch.intervalS = limits.minIntervalSeconds;
          }
          if (row.regions.length > limits.regionsPerMonitor) {
            patch.regions = row.regions.slice(0, limits.regionsPerMonitor);
            patch.policies = {
              ...row.policies,
              minFailingRegions: Math.min(row.policies.minFailingRegions, limits.regionsPerMonitor),
            };
          }
          if (Object.keys(patch).length > 0) {
            await change(row, patch);
            result.adjusted += 1;
          }
        }
        return result;
      });
    },

    async delete(scope, id) {
      await db.transaction(async (tx) => {
        const row = await repo.delete(tx, scope, id);
        if (row === undefined) throw new NotFoundError("Monitor not found.");
        await recordChange(tx, scope, id, "delete");
        await deps.outbox.emit(
          tx,
          "monitor.deleted",
          { monitorId: id },
          { workspaceId: scope.workspaceId },
        );
      });
    },

    listTags: (scope) => repo.listTags(scope),

    async createGroup(scope, name, groupAlerts = false) {
      const row = await repo.insertGroup(db, {
        id: deps.newId(),
        workspaceId: scope.workspaceId,
        name,
        groupAlerts,
      });
      if (row === undefined) throw new ConflictError(`A group named "${name}" already exists.`);
      return toGroup(row);
    },

    async listGroups(scope) {
      return (await repo.listGroups(scope)).map(toGroup);
    },

    async renameGroup(scope, id, name, groupAlerts) {
      try {
        const row = await repo.updateGroup(scope, id, { name, groupAlerts });
        if (row === undefined) throw new NotFoundError("Group not found.");
        return toGroup(row);
      } catch (err) {
        if (isUniqueViolation(err))
          throw new ConflictError(`A group named "${name}" already exists.`);
        throw err;
      }
    },

    async deleteGroup(scope, id) {
      if (!(await repo.deleteGroup(scope, id))) throw new NotFoundError("Group not found.");
    },

    async changesSince(afterSeq, limit) {
      const changes = await repo.changesSince(afterSeq, limit);
      const cursor = changes.at(-1)?.seq ?? afterSeq;
      /* The latest op per monitor wins within this page. */
      const latest = new Map<string, "upsert" | "delete">();
      for (const change of changes) latest.set(change.monitorId, change.op);
      const upsertIds = [...latest].filter(([, op]) => op === "upsert").map(([id]) => id);
      const rows = await repo.findByIdsUnscoped(upsertIds);
      const found = new Set(rows.map((r) => r.id));
      const deletes = [...latest]
        .filter(([id, op]) => op === "delete" || !found.has(id))
        .map(([id]) => id);
      return {
        cursor,
        upserts: forProbes(rows),
        deletes,
      };
    },

    latestSeq: () => repo.latestSeq(),

    async listForProbes({ afterId, limit }) {
      const rows = await repo.activeUnscoped(limit, afterId);
      return {
        monitors: forProbes(rows),
        nextAfterId: rows.length === limit ? (rows.at(-1)?.id ?? null) : null,
      };
    },

    async getForProbes(ids) {
      return forProbes(await repo.findByIdsUnscoped(ids));
    },

    async listByType(types, { afterId, limit }) {
      const rows = await repo.byTypeUnscoped(types, limit, afterId);
      return {
        monitors: forProbes(rows),
        nextAfterId: rows.length === limit ? (rows.at(-1)?.id ?? null) : null,
      };
    },

    async changeTimes(scope, id, from, to) {
      await mustFind(db, scope, id);
      return repo.changeTimes(id, from, to);
    },

    async getForDetection(ids) {
      const rows = await repo.findByIdsUnscoped(ids);
      const groups = new Map(
        (
          await repo.groupsByIdsUnscoped([
            ...new Set(rows.flatMap((r) => (r.groupId === null ? [] : [r.groupId]))),
          ])
        ).map((g) => [g.id, g]),
      );
      const groupOf = (row: MonitorRow) => {
        const g = row.groupId === null ? undefined : groups.get(row.groupId);
        /* Never a group from another workspace, whatever the row says. */
        if (g === undefined || g.workspaceId !== row.workspaceId) return null;
        return { id: g.id, name: g.name, groupAlerts: g.groupAlerts };
      };
      return rows.map((row) => ({
        id: row.id,
        workspaceId: row.workspaceId,
        name: row.name,
        type: row.type,
        regions: row.regions,
        intervalSeconds: row.intervalS,
        severity: row.severity,
        paused: row.paused,
        parentId: row.parentId ?? null,
        group: groupOf(row),
        alertPolicyId: row.alertPolicyId ?? null,
        policies: row.policies,
        target: targetHostOf(row.config),
      }));
    },
  };

  /*
   * One monitor whose secrets can't be decrypted (a retired key, a corrupted value) must not break
   * every probe's sync: it is skipped and reported instead.
   */
  function forProbes(rows: MonitorRow[]): MonitorForProbe[] {
    return rows.flatMap((row) => {
      try {
        return [forProbe(row)];
      } catch (err) {
        deps.onSecretError?.(row.id, err);
        return [];
      }
    });
  }

  function forProbe(row: MonitorRow): MonitorForProbe {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      config: applySecrets(row.config, decryptSecrets(row)),
      intervalSeconds: row.intervalS,
      timeoutMs: row.timeoutMs,
      regions: row.regions,
      configSeq: row.configSeq,
      paused: row.paused,
    };
  }
  return service;
}

/* Where a monitor sends its requests: the URL's origin, or host and port. */
function targetOf(config: MonitorRow["config"] | MonitorConfig): string {
  const c = config as Record<string, unknown>;
  /* A multi-step check goes to every server its steps name. */
  if (Array.isArray(c.steps)) {
    const origins = (c.steps as Array<{ url?: unknown }>).map((step) => {
      const url = typeof step.url === "string" ? step.url : "";
      return /^https?:\/\/[^/?#]+/i.exec(url)?.[0].toLowerCase() ?? url;
    });
    return [...new Set(origins)].sort().join(" ");
  }
  if (typeof c.url === "string") {
    try {
      return new URL(c.url).origin;
    } catch {
      return c.url;
    }
  }
  return `${String(c.host ?? c.hostname ?? c.domain ?? "")}:${String(c.port ?? "")}`;
}

/* The hostname a monitor checks, from its (secret-free) stored config. */
function targetHostOf(config: MonitorRow["config"]): string | null {
  const c = config as Record<string, unknown>;
  /* A multi-step check: where its first step goes. */
  const first = Array.isArray(c.steps) ? (c.steps[0] as { url?: unknown } | undefined) : undefined;
  if (typeof first?.url === "string") {
    return (
      /^https?:\/\/(\[[^\]]+\]|[^/?#:]+)/i.exec(first.url)?.[1]?.replace(/^\[|\]$/g, "") ?? null
    );
  }
  if (typeof c.url === "string") {
    try {
      return new URL(c.url).hostname;
    } catch {
      return null;
    }
  }
  for (const key of ["host", "hostname", "domain"] as const) {
    if (typeof c[key] === "string") return c[key];
  }
  return null;
}

/* Cron schedules need a real parse (the schema only checks the five-field shape). */
function checkSchedule(config: MonitorConfig): void {
  if (config.type !== "heartbeat" || config.schedule.kind !== "cron") return;
  const problem = cronProblem(config.schedule.expression, config.schedule.timezone);
  if (problem !== null) {
    throw new ValidationError("The heartbeat schedule is invalid.", [
      { path: "config.schedule", message: problem },
    ]);
  }
}

function issuesOf(
  error: { issues: Array<{ path: PropertyKey[]; message: string }> },
  prefix?: string,
) {
  return error.issues.map((issue) => ({
    path: [prefix, ...issue.path.map(String)].filter(Boolean).join("."),
    message: issue.message,
  }));
}

function isUniqueViolation(err: unknown): boolean {
  const code =
    (err as { code?: string; cause?: { code?: string } }).code ??
    (err as { cause?: { code?: string } }).cause?.code;
  return code === "23505";
}
