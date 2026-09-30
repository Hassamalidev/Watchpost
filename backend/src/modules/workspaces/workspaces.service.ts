/*
 * Workspace rules: memberships (created through Better Auth), settings and incident numbers.
 * Settings are created once per workspace, together with the workspace.created event, in one
 * transaction; ensureSettings is idempotent so the creation hook, lazy reads and the recovery
 * sweep can all call it.
 */
import type { Clock } from "../../core/clock.js";
import { NotFoundError } from "../../core/errors.js";
import type { SessionContext } from "../../core/session.js";
import {
  createWorkspaceScope,
  type WorkspaceRole,
  type WorkspaceScope,
} from "../../core/workspace-scope.js";
import type { Db, DbOrTx } from "../../infra/db/index.js";
import type { Outbox } from "../../infra/outbox/index.js";
import { parseMemberRole } from "../../middleware/roles.js";
import type { WorkspaceSettingsRow } from "./schema/workspace-settings.js";
import type { WorkspacesRepository } from "./workspaces.repository.js";

export const TRIAL_DAYS = 14;

export interface WorkspaceMember {
  userId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  joinedAt: string;
}

export interface WorkspaceSettings {
  workspaceId: string;
  timezone: string;
  trialEndsAt: string | null;
  flags: Record<string, boolean>;
}

export interface WorkspacesService {
  resolveRole(userId: string, workspaceId: string): Promise<WorkspaceRole | undefined>;
  me(
    scope: WorkspaceScope,
    session: SessionContext,
  ): { workspaceId: string; userId: string; email: string; role: WorkspaceScope["role"] };
  listMembers(scope: WorkspaceScope): Promise<WorkspaceMember[]>;
  /* The workspace's display name ("Acme"); empty if the workspace is gone. */
  workspaceName(scope: WorkspaceScope): Promise<string>;
  /* Creates default settings and emits workspace.created, once. Returns true if it created them. */
  ensureSettings(workspaceId: string): Promise<boolean>;
  getSettings(scope: WorkspaceScope): Promise<WorkspaceSettings>;
  updateSettings(scope: WorkspaceScope, patch: { timezone?: string }): Promise<WorkspaceSettings>;
  /* Next per-workspace incident number (#1, #2, …); pass the caller's transaction. */
  nextIncidentNumber(tx: DbOrTx, scope: WorkspaceScope): Promise<number>;
  /* System: every workspace ID, paged (digests and other per-workspace jobs). */
  workspaceIds(options: { afterId?: string; limit: number }): Promise<string[]>;
  /* Recovery: creates settings for workspaces that are missing them. Returns how many. */
  repairMissingSettings(limit?: number): Promise<number>;
}

function toSettings(row: WorkspaceSettingsRow): WorkspaceSettings {
  return {
    workspaceId: row.workspaceId,
    timezone: row.timezone,
    trialEndsAt: row.trialEndsAt?.toISOString() ?? null,
    flags: row.flags,
  };
}

export function createWorkspacesService(deps: {
  db: Db;
  repository: WorkspacesRepository;
  outbox: Outbox;
  clock: Clock;
}): WorkspacesService {
  const { repository, clock } = deps;

  const service: WorkspacesService = {
    async resolveRole(userId, workspaceId) {
      return parseMemberRole(await repository.findMemberRole(userId, workspaceId));
    },

    me(scope, session) {
      return {
        workspaceId: scope.workspaceId,
        userId: session.userId,
        email: session.email,
        role: scope.role,
      };
    },

    async workspaceName(scope) {
      return (await repository.workspaceName(scope)) ?? "";
    },

    async listMembers(scope) {
      const rows = await repository.listMembers(scope);
      return rows.flatMap((row) => {
        const role = parseMemberRole(row.role);
        if (role === undefined) return [];
        return [
          {
            userId: row.userId,
            name: row.name,
            email: row.email,
            role,
            joinedAt: row.joinedAt.toISOString(),
          },
        ];
      });
    },

    async ensureSettings(workspaceId) {
      const trialEndsAt = new Date(clock.now().getTime() + TRIAL_DAYS * 86_400_000);
      return deps.db.transaction(async (tx) => {
        const created = await repository.insertSettingsIfMissing(tx, { workspaceId, trialEndsAt });
        if (created) {
          await deps.outbox.emit(tx, "workspace.created", { workspaceId }, { workspaceId });
        }
        return created;
      });
    },

    async getSettings(scope) {
      let row = await repository.findSettings(scope);
      if (row === undefined) {
        await service.ensureSettings(scope.workspaceId);
        row = await repository.findSettings(scope);
      }
      if (row === undefined) throw new NotFoundError("Workspace not found.");
      return toSettings(row);
    },

    async updateSettings(scope, patch) {
      await service.getSettings(scope);
      const row = await repository.updateSettings(scope, patch);
      if (row === undefined) throw new NotFoundError("Workspace not found.");
      return toSettings(row);
    },

    async nextIncidentNumber(tx, scope) {
      let number = await repository.nextIncidentNumber(tx, scope);
      if (number === undefined) {
        await repository.insertSettingsIfMissing(tx, {
          workspaceId: scope.workspaceId,
          trialEndsAt: new Date(clock.now().getTime() + TRIAL_DAYS * 86_400_000),
        });
        number = await repository.nextIncidentNumber(tx, scope);
      }
      if (number === undefined) throw new NotFoundError("Workspace not found.");
      return number;
    },

    workspaceIds: ({ afterId, limit }) => repository.workspaceIds(limit, afterId),

    async repairMissingSettings(limit = 500) {
      const missing = await repository.findWorkspacesWithoutSettings(limit);
      let created = 0;
      for (const workspaceId of missing) {
        if (await service.ensureSettings(workspaceId)) created += 1;
      }
      return created;
    },
  };
  return service;
}

/* Scope for system work on one workspace (hooks, sweeps). */
export function systemScope(workspaceId: string): WorkspaceScope {
  return createWorkspaceScope({ workspaceId });
}
