/*
 * Workspaces data. Better Auth owns `member`, `user` and `organization` (infra/auth); this repository
 * is the only place modules read them (PRODUCT.md §7.4). It also owns workspace_settings.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { assertWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import { member, organization, user } from "../../infra/auth/schema.js";
import type { DbOrTx } from "../../infra/db/index.js";
import { workspaceSettings, type WorkspaceSettingsRow } from "./schema/workspace-settings.js";

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

    /* Inserts default settings; returns true only if this call created the row. */
    async insertSettingsIfMissing(
      tx: DbOrTx,
      values: { workspaceId: string; trialEndsAt: Date },
    ): Promise<boolean> {
      const rows = await tx
        .insert(workspaceSettings)
        .values(values)
        .onConflictDoNothing({ target: workspaceSettings.workspaceId })
        .returning({ workspaceId: workspaceSettings.workspaceId });
      return rows.length > 0;
    },

    async findSettings(scope: WorkspaceScope): Promise<WorkspaceSettingsRow | undefined> {
      assertWorkspaceScope(scope);
      const rows = await db
        .select()
        .from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, scope.workspaceId))
        .limit(1);
      return rows[0];
    },

    async updateSettings(
      scope: WorkspaceScope,
      patch: Partial<Pick<WorkspaceSettingsRow, "timezone">>,
    ): Promise<WorkspaceSettingsRow | undefined> {
      assertWorkspaceScope(scope);
      const rows = await db
        .update(workspaceSettings)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(eq(workspaceSettings.workspaceId, scope.workspaceId))
        .returning();
      return rows[0];
    },

    /* Atomically takes the next incident number; the row lock serializes concurrent callers. */
    async nextIncidentNumber(tx: DbOrTx, scope: WorkspaceScope): Promise<number | undefined> {
      assertWorkspaceScope(scope);
      const rows = await tx
        .update(workspaceSettings)
        .set({ incidentSeq: sql`${workspaceSettings.incidentSeq} + 1` })
        .where(eq(workspaceSettings.workspaceId, scope.workspaceId))
        .returning({ number: workspaceSettings.incidentSeq });
      return rows[0]?.number;
    },

    /* Workspaces whose settings row was never created (crash between Better Auth and our hook). */
    async findWorkspacesWithoutSettings(limit: number): Promise<string[]> {
      const rows = await db
        .select({ id: organization.id })
        .from(organization)
        .leftJoin(workspaceSettings, eq(workspaceSettings.workspaceId, organization.id))
        .where(isNull(workspaceSettings.workspaceId))
        .limit(limit);
      return rows.map((r) => r.id);
    },
  };
}
