/*
 * Workspace memberships. Better Auth owns `member` and `user` (infra/auth); this repository is the
 * only place modules read them (PRODUCT.md §7.4). Workspace = Better Auth organization.
 */
import { and, asc, eq } from "drizzle-orm";
import { assertWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import { member, user } from "../../infra/auth/schema.js";
import type { DbOrTx } from "../../infra/db/index.js";

export interface MemberRow {
  userId: string;
  name: string;
  email: string;
  role: string;
  joinedAt: Date;
}

export type WorkspacesRepository = ReturnType<typeof createWorkspacesRepository>;

export function createWorkspacesRepository(db: DbOrTx) {
  return {
    /* Raw role string ("admin" or "admin,member"), or undefined if not a member. */
    async findMemberRole(userId: string, workspaceId: string): Promise<string | undefined> {
      const rows = await db
        .select({ role: member.role })
        .from(member)
        .where(and(eq(member.userId, userId), eq(member.organizationId, workspaceId)))
        .limit(1);
      return rows[0]?.role;
    },

    async listMembers(scope: WorkspaceScope): Promise<MemberRow[]> {
      assertWorkspaceScope(scope);
      return db
        .select({
          userId: member.userId,
          name: user.name,
          email: user.email,
          role: member.role,
          joinedAt: member.createdAt,
        })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(eq(member.organizationId, scope.workspaceId))
        .orderBy(asc(member.createdAt));
    },
  };
}
