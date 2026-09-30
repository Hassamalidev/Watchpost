/* Workspace membership rules. Workspaces, members and invitations are created through Better Auth. */
import type { Clock } from "../../core/clock.js";
import type { SessionContext } from "../../core/session.js";
import type { WorkspaceRole, WorkspaceScope } from "../../core/workspace-scope.js";
import { parseMemberRole } from "../../middleware/roles.js";
import type { WorkspacesRepository } from "./workspaces.repository.js";

export interface WorkspaceMember {
  userId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  joinedAt: string;
}

export interface WorkspacesService {
  /* The member's highest role in the workspace, or undefined for non-members. */
  resolveRole(userId: string, workspaceId: string): Promise<WorkspaceRole | undefined>;
  me(
    scope: WorkspaceScope,
    session: SessionContext,
  ): { workspaceId: string; userId: string; email: string; role: WorkspaceScope["role"] };
  listMembers(scope: WorkspaceScope): Promise<WorkspaceMember[]>;
}

export function createWorkspacesService(deps: {
  repository: WorkspacesRepository;
  clock: Clock;
}): WorkspacesService {
  const { repository } = deps;
  return {
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
  };
}
