/*
 * Workspace rules: memberships (created through Better Auth), settings and incident numbers.
 * Settings are created once per workspace, together with the workspace.created event, in one
 * transaction; ensureSettings is idempotent so the creation hook, lazy reads and the recovery
 * sweep can all call it.
 */
import { randomUUID } from "node:crypto";
import type { Clock } from "../../core/clock.js";
import type { PlanFeature } from "@app/shared";
import { ConflictError, NotFoundError, QuotaExceededError } from "../../core/errors.js";
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
  /* Members need two-factor sign-in to open the workspace. */
  requireTwoFactor: boolean;
  trialEndsAt: string | null;
  flags: Record<string, boolean>;
}

export interface ClientWorkspace {
  id: string;
  name: string;
  createdAt: string;
}

export interface WorkspacesService {
  resolveRole(userId: string, workspaceId: string): Promise<WorkspaceRole | undefined>;
  /* The agency workspace this one is a client of, if any (its plan pays for this one). */
  parentOf(workspaceId: string): Promise<string | undefined>;
  /*
   * System (people changed in an agency): its owners and admins are admin members of every client
   * workspace, and nobody else is one on the agency's account.
   */
  syncClientAdmins(agencyId: string): Promise<void>;
  listClients(scope: WorkspaceScope): Promise<ClientWorkspace[]>;
  /* Creates a client workspace under this one, owned by whoever asks. */
  createClient(
    scope: WorkspaceScope,
    name: string,
    session: Pick<SessionContext, "userId">,
  ): Promise<ClientWorkspace>;
  me(
    scope: WorkspaceScope,
    session: SessionContext,
  ): Promise<{
    workspaceId: string;
    userId: string;
    email: string;
    role: WorkspaceScope["role"];
    twoFactorEnabled: boolean;
    twoFactorRequired: boolean;
    /* The workspace's name, and the agency it is a client of. */
    name: string;
    parent: { id: string; name: string } | null;
  }>;
  listMembers(scope: WorkspaceScope): Promise<WorkspaceMember[]>;
  countMembers(scope: WorkspaceScope): Promise<number>;
  /* Who hears about billing: owners, admins and members with the billing role. */
  billingContacts(scope: WorkspaceScope): Promise<WorkspaceMember[]>;
  /* System: workspaces whose trial ends in [from, to), paged by ID. */
  trialsEndingBetween(options: {
    from: Date;
    to: Date;
    afterId?: string | undefined;
    limit: number;
  }): Promise<Array<{ workspaceId: string; trialEndsAt: Date }>>;
  /* System: whether the workspace still exists (webhooks name workspaces by ID). */
  exists(workspaceId: string): Promise<boolean>;
  /* The workspace's display name ("Acme"); empty if the workspace is gone. */
  workspaceName(scope: WorkspaceScope): Promise<string>;
  /* Creates default settings and emits workspace.created, once. Returns true if it created them. */
  ensureSettings(workspaceId: string): Promise<boolean>;
  getSettings(scope: WorkspaceScope): Promise<WorkspaceSettings>;
  /* `session` is who is asking: requiring two-factor sign-in needs them to have it themselves. */
  updateSettings(
    scope: WorkspaceScope,
    patch: { timezone?: string | undefined; requireTwoFactor?: boolean | undefined },
    session?: Pick<SessionContext, "twoFactorEnabled">,
  ): Promise<WorkspaceSettings>;
  /* System (the workspace guard): does this workspace require two-factor sign-in? Cached briefly. */
  requiresTwoFactor(workspaceId: string): Promise<boolean>;
  /* Next per-workspace incident number (#1, #2, …); pass the caller's transaction. */
  nextIncidentNumber(tx: DbOrTx, scope: WorkspaceScope): Promise<number>;
  /* System: every workspace ID, paged (digests and other per-workspace jobs). */
  workspaceIds(options: { afterId?: string; limit: number }): Promise<string[]>;
  /* Recovery: creates settings for workspaces that are missing them. Returns how many. */
  repairMissingSettings(limit?: number): Promise<number>;
}

const POLICY_CACHE_MS = 10_000;

function toSettings(row: WorkspaceSettingsRow): WorkspaceSettings {
  return {
    workspaceId: row.workspaceId,
    timezone: row.timezone,
    requireTwoFactor: row.requireTwoFactor,
    trialEndsAt: row.trialEndsAt?.toISOString() ?? null,
    flags: row.flags,
  };
}

export function createWorkspacesService(deps: {
  db: Db;
  repository: WorkspacesRepository;
  outbox: Outbox;
  clock: Clock;
  /* The billing module's answer to "does the plan include it?"; absent in tests without billing. */
  hasFeature?: ((scope: WorkspaceScope, feature: PlanFeature) => Promise<boolean>) | undefined;
  /* How many client workspaces the plan includes (billing, wired by the container). */
  clientLimit?: ((scope: WorkspaceScope) => Promise<number>) | undefined;
  /* Runs one change at a time per key (an advisory lock; tests run without one). */
  lock?: (<T>(key: string, fn: () => Promise<T>) => Promise<T>) | undefined;
  /* IDs for the memberships we add ourselves. */
  newId?: (() => string) | undefined;
  /* Creates a workspace owned by the given person (the auth library) and answers its ID. */
  createWorkspace?: ((input: { name: string; ownerUserId: string }) => Promise<string>) | undefined;
}): WorkspacesService {
  const { repository, clock } = deps;
  /*
   * The guard asks on every request, so the answer is kept for a few seconds. Another API process
   * learns of a change within that time.
   */
  const policyCache = new Map<string, { required: boolean; until: number }>();
  /* Which agency a workspace belongs to is asked on every request too, and almost never changes. */
  const parentCache = new Map<string, { parentId: string | undefined; until: number }>();

  const service: WorkspacesService = {
    async resolveRole(userId, workspaceId) {
      const own = parseMemberRole(await repository.findMemberRole(userId, workspaceId));
      const parentId = await service.parentOf(workspaceId);
      if (parentId === undefined) return own;
      /*
       * Client workspaces: the agency's owners and admins run them as admins. They are made real
       * members (the sign-in library, which sends invitations, knows only those), and that
       * membership goes when their standing in the agency does. Everyone else of the agency has no
       * access unless invited there.
       */
      const inAgency = parseMemberRole(await repository.findMemberRole(userId, parentId));
      const runsAgency = inAgency === "owner" || inAgency === "admin";
      if (own !== undefined) {
        if (runsAgency || !(await repository.hasGrant(workspaceId, userId))) return own;
        /* A membership that came with a standing they no longer have. */
        await repository.revokeClientAdmin(workspaceId, userId);
        return undefined;
      }
      if (!runsAgency) return undefined;
      await repository.grantClientAdmin(workspaceId, userId, deps.newId?.() ?? randomUUID());
      return "admin";
    },

    async syncClientAdmins(agencyId) {
      const clients = await repository.listClients(systemScope(agencyId));
      if (clients.length === 0) return;
      const admins = new Set(
        (await repository.memberRoles(agencyId))
          .filter((m) => {
            const role = parseMemberRole(m.role);
            return role === "owner" || role === "admin";
          })
          .map((m) => m.userId),
      );
      for (const client of clients) {
        const members = new Set((await repository.memberRoles(client.id)).map((m) => m.userId));
        for (const userId of admins) {
          if (!members.has(userId)) {
            await repository.grantClientAdmin(client.id, userId, deps.newId?.() ?? randomUUID());
          }
        }
        for (const userId of await repository.grantedUserIds(client.id)) {
          if (!admins.has(userId)) await repository.revokeClientAdmin(client.id, userId);
        }
      }
    },

    async parentOf(workspaceId) {
      const now = clock.now().getTime();
      const cached = parentCache.get(workspaceId);
      if (cached !== undefined && cached.until > now) return cached.parentId;
      const parentId = await repository.findParent(workspaceId);
      if (parentCache.size >= 10_000) parentCache.clear();
      parentCache.set(workspaceId, { parentId, until: now + POLICY_CACHE_MS });
      return parentId;
    },

    async listClients(scope) {
      return (await repository.listClients(scope)).map((client) => ({
        id: client.id,
        name: client.name,
        createdAt: client.createdAt.toISOString(),
      }));
    },

    async createClient(scope, name, session) {
      if ((await service.parentOf(scope.workspaceId)) !== undefined) {
        throw new ConflictError("A client workspace can't have client workspaces of its own.");
      }
      /* One at a time per agency, so the plan's number can't be passed by a burst. */
      const lock = deps.lock ?? ((_key: string, fn: () => Promise<ClientWorkspace>) => fn());
      return lock(`clients:${scope.workspaceId}`, async () => {
        const limit = (await deps.clientLimit?.(scope)) ?? 0;
        const existing = await repository.listClients(scope);
        if (existing.length >= limit) {
          throw new QuotaExceededError(
            limit === 0
              ? "Client workspaces are part of the Business plan."
              : `Your plan includes ${limit} client workspaces. Add more to your plan to create another.`,
          );
        }
        if (deps.createWorkspace === undefined) throw new Error("workspace creation isn't wired");
        const id = await deps.createWorkspace({ name, ownerUserId: session.userId });
        await repository.linkClient(id, scope.workspaceId);
        parentCache.delete(id);
        await service.syncClientAdmins(scope.workspaceId);
        /*
         * No trial of its own: the agency's plan pays for it, so nothing should count down, send
         * trial emails or downgrade it on its own clock.
         */
        await service.ensureSettings(id);
        await repository.updateSettings(systemScope(id), { trialEndsAt: null });
        return { id, name, createdAt: clock.now().toISOString() };
      });
    },

    async me(scope, session) {
      const parentId = await service.parentOf(scope.workspaceId);
      return {
        name: await service.workspaceName(scope),
        parent:
          parentId === undefined
            ? null
            : { id: parentId, name: await service.workspaceName(systemScope(parentId)) },
        workspaceId: scope.workspaceId,
        userId: session.userId,
        email: session.email,
        role: scope.role,
        twoFactorEnabled: session.twoFactorEnabled,
        /* True while this person is locked out of the workspace until they set it up. */
        twoFactorRequired:
          !session.twoFactorEnabled && (await service.requiresTwoFactor(scope.workspaceId)),
      };
    },

    async requiresTwoFactor(workspaceId) {
      const now = clock.now().getTime();
      const cached = policyCache.get(workspaceId);
      if (cached !== undefined && cached.until > now) return cached.required;
      const row = await repository.findSettings(systemScope(workspaceId));
      const required = row?.requireTwoFactor === true;
      if (policyCache.size >= 10_000) policyCache.clear();
      policyCache.set(workspaceId, { required, until: now + POLICY_CACHE_MS });
      return required;
    },

    async exists(workspaceId) {
      return (await repository.workspaceName(systemScope(workspaceId))) !== undefined;
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

    countMembers: (scope) => repository.countMembers(scope),

    async billingContacts(scope) {
      const members = await service.listMembers(scope);
      return members.filter(
        (m) => m.role === "owner" || m.role === "admin" || m.role === "billing",
      );
    },

    trialsEndingBetween: ({ from, to, afterId, limit }) =>
      repository.trialsEndingBetween(from, to, limit, afterId),

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

    async updateSettings(scope, patch, session) {
      const current = await service.getSettings(scope);
      if (patch.requireTwoFactor === true && !current.requireTwoFactor) {
        if (!(await deps.hasFeature?.(scope, "sso"))) {
          throw new QuotaExceededError(
            "Requiring two-factor sign-in is part of the Business plan.",
          );
        }
        /* Whoever switches it on would be the first one locked out. */
        if (session !== undefined && !session.twoFactorEnabled) {
          throw new ConflictError(
            "Set up two-factor sign-in for your own account first, then require it for everyone.",
          );
        }
      }
      const row = await repository.updateSettings(scope, {
        ...(patch.timezone === undefined ? {} : { timezone: patch.timezone }),
        ...(patch.requireTwoFactor === undefined
          ? {}
          : { requireTwoFactor: patch.requireTwoFactor }),
      });
      if (row === undefined) throw new NotFoundError("Workspace not found.");
      policyCache.delete(scope.workspaceId);
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
