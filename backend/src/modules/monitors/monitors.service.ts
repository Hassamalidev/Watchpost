/*
 * Monitor configuration rules (PRODUCT.md §6.1–6.2, §5 limits). Every write runs in one transaction
 * that also appends to the global change feed (probes sync from it) and emits the monitor event.
 */
import {
  createMonitorSchema,
  monitorConfigSchema,
  monitorSettingsSchema,
  type CreateMonitorInput,
  type MonitorConfig,
  type MonitorSettings,
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
import type { Db, DbOrTx } from "../../infra/db/index.js";
import type { Outbox } from "../../infra/outbox/index.js";
import type { MonitorRow } from "./schema/monitors.js";
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
  recoverySuccesses: number;
  degradedLatencyMs: number | null;
  degradedAfterChecks: number;
  upsideDown: boolean;
  reminderMinutes: number | null;
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

export interface MonitorsService {
  create(scope: WorkspaceScope, input: CreateMonitorInput): Promise<MonitorView>;
  get(scope: WorkspaceScope, id: string): Promise<MonitorView>;
  list(
    scope: WorkspaceScope,
    filters: ListFilters,
  ): Promise<{ data: MonitorView[]; nextCursor: string | null }>;
  update(scope: WorkspaceScope, id: string, input: UpdateMonitorInput): Promise<MonitorView>;
  setPaused(scope: WorkspaceScope, id: string, paused: boolean): Promise<MonitorView>;
  delete(scope: WorkspaceScope, id: string): Promise<void>;
  listTags(scope: WorkspaceScope): Promise<Array<{ id: string; name: string }>>;
  createGroup(scope: WorkspaceScope, name: string): Promise<MonitorGroupView>;
  listGroups(scope: WorkspaceScope): Promise<MonitorGroupView[]>;
  renameGroup(scope: WorkspaceScope, id: string, name: string): Promise<MonitorGroupView>;
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
}

export interface MonitorsServiceDeps {
  db: Db;
  repository: MonitorsRepository;
  outbox: Outbox;
  clock: Clock;
  cipher: TokenCipher;
  newId: () => string;
  limits: (scope: WorkspaceScope) => Promise<PlanLimits>;
}

const secretsAad = (monitorId: string) => `monitor:${monitorId}`;

function settingsOf(row: MonitorRow, tags: string[]): MonitorSettings {
  return {
    name: row.name,
    intervalSeconds: row.intervalS,
    timeoutMs: row.timeoutMs,
    regions: row.regions as MonitorSettings["regions"],
    minFailingRegions: row.policies.minFailingRegions,
    recoverySuccesses: row.policies.recoverySuccesses,
    degradedLatencyMs: row.policies.degradedLatencyMs,
    degradedAfterChecks: row.policies.degradedAfterChecks,
    upsideDown: row.policies.upsideDown,
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
    recoverySuccesses: row.policies.recoverySuccesses,
    degradedLatencyMs: row.policies.degradedLatencyMs ?? null,
    degradedAfterChecks: row.policies.degradedAfterChecks,
    upsideDown: row.policies.upsideDown,
    reminderMinutes: row.policies.reminderMinutes ?? null,
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
      recoverySuccesses: settings.recoverySuccesses,
      degradedLatencyMs: settings.degradedLatencyMs,
      degradedAfterChecks: settings.degradedAfterChecks,
      upsideDown: settings.upsideDown,
      reminderMinutes: settings.reminderMinutes,
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
      const id = deps.newId();

      return db.transaction(async (tx) => {
        await repo.lockWorkspace(tx, scope);
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
      return db.transaction(async (tx) => {
        await repo.lockWorkspace(tx, scope);
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
          if (configResult.data.type !== row.type) {
            throw new ValidationError(
              "A monitor's type can't change; create a new monitor instead.",
              [{ path: "config.type", message: `must stay "${row.type}"` }],
            );
          }
          const merged = applySecrets(configResult.data, decryptSecrets(row));
          if (hasUnresolvedMask(merged)) {
            throw new ValidationError("A masked secret has no stored value; enter it again.", [
              { path: "config", message: "masked value without a stored secret" },
            ]);
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
      return db.transaction(async (tx) => {
        await repo.lockWorkspace(tx, scope);
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

    async createGroup(scope, name) {
      const row = await repo.insertGroup(db, {
        id: deps.newId(),
        workspaceId: scope.workspaceId,
        name,
      });
      if (row === undefined) throw new ConflictError(`A group named "${name}" already exists.`);
      return { id: row.id, name: row.name, createdAt: row.createdAt.toISOString() };
    },

    async listGroups(scope) {
      return (await repo.listGroups(scope)).map((g) => ({
        id: g.id,
        name: g.name,
        createdAt: g.createdAt.toISOString(),
      }));
    },

    async renameGroup(scope, id, name) {
      try {
        const row = await repo.renameGroup(scope, id, name);
        if (row === undefined) throw new NotFoundError("Group not found.");
        return { id: row.id, name: row.name, createdAt: row.createdAt.toISOString() };
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
        upserts: rows.map((row) => ({
          id: row.id,
          workspaceId: row.workspaceId,
          config: applySecrets(row.config, decryptSecrets(row)),
          intervalSeconds: row.intervalS,
          timeoutMs: row.timeoutMs,
          regions: row.regions,
          configSeq: row.configSeq,
          paused: row.paused,
        })),
        deletes,
      };
    },

    latestSeq: () => repo.latestSeq(),
  };
  return service;
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
