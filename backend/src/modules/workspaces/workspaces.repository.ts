/*
 * Workspaces data. Better Auth owns `member`, `user` and `organization` (infra/auth); this repository
 * is the only place modules read them (PRODUCT.md §7.4). It also owns workspace_settings.
 */
import { and, asc, eq, gt, gte, isNull, lt, sql } from "drizzle-orm";
import { assertWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import { member, organization, user } from "../../infra/auth/schema.js";
import type { DbOrTx } from "../../infra/db/index.js";
import { clientAdminGrants, workspaceParents } from "./schema/workspace-parents.js";
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

    /* The agency workspace a client workspace belongs to, if it is one. */
    async findParent(workspaceId: string): Promise<string | undefined> {
      const rows = await db
        .select({ parentId: workspaceParents.parentId })
        .from(workspaceParents)
        .where(eq(workspaceParents.workspaceId, workspaceId))
        .limit(1);
      return rows[0]?.parentId;
    },

    /* Every member of a workspace with their raw role string. */
    async memberRoles(workspaceId: string): Promise<Array<{ userId: string; role: string }>> {
      return db
        .select({ userId: member.userId, role: member.role })
        .from(member)
        .where(eq(member.organizationId, workspaceId));
    },

    /* The people who are members of a client workspace through the agency. */
    async grantedUserIds(workspaceId: string): Promise<string[]> {
      const rows = await db
        .select({ userId: clientAdminGrants.userId })
        .from(clientAdminGrants)
        .where(eq(clientAdminGrants.workspaceId, workspaceId));
      return rows.map((row) => row.userId);
    },

    async hasGrant(workspaceId: string, userId: string): Promise<boolean> {
      const rows = await db
        .select({ userId: clientAdminGrants.userId })
        .from(clientAdminGrants)
        .where(
          and(eq(clientAdminGrants.workspaceId, workspaceId), eq(clientAdminGrants.userId, userId)),
        )
        .limit(1);
      return rows.length > 0;
    },

    /* Makes an agency admin an admin member of a client workspace, and notes why. */
    async grantClientAdmin(workspaceId: string, userId: string, memberId: string): Promise<void> {
      await db.transaction(async (tx) => {
        const granted = await tx
          .insert(clientAdminGrants)
          .values({ workspaceId, userId })
          .onConflictDoNothing()
          .returning({ userId: clientAdminGrants.userId });
        if (granted.length === 0) return;
        const existing = await tx
          .select({ id: member.id })
          .from(member)
          .where(and(eq(member.organizationId, workspaceId), eq(member.userId, userId)))
          .limit(1);
        if (existing.length > 0) {
          /* Already a member in their own right: nothing of ours to remove later. */
          await tx
            .delete(clientAdminGrants)
            .where(
              and(
                eq(clientAdminGrants.workspaceId, workspaceId),
                eq(clientAdminGrants.userId, userId),
              ),
            );
          return;
        }
        await tx.insert(member).values({
          id: memberId,
          organizationId: workspaceId,
          userId,
          role: "admin",
          createdAt: new Date(),
        });
      });
    },

    /* Takes back a membership that came with standing in the agency. */
    async revokeClientAdmin(workspaceId: string, userId: string): Promise<void> {
      await db.transaction(async (tx) => {
        const revoked = await tx
          .delete(clientAdminGrants)
          .where(
            and(
              eq(clientAdminGrants.workspaceId, workspaceId),
              eq(clientAdminGrants.userId, userId),
            ),
          )
          .returning({ userId: clientAdminGrants.userId });
        if (revoked.length === 0) return;
        await tx
          .delete(member)
          .where(and(eq(member.organizationId, workspaceId), eq(member.userId, userId)));
      });
    },

    async linkClient(workspaceId: string, parentId: string): Promise<void> {
      await db.insert(workspaceParents).values({ workspaceId, parentId });
    },

    /* An agency's client workspaces, oldest first. */
    async listClients(
      scope: WorkspaceScope,
    ): Promise<Array<{ id: string; name: string; createdAt: Date }>> {
      assertWorkspaceScope(scope);
      return db
        .select({
          id: organization.id,
          name: organization.name,
          createdAt: workspaceParents.createdAt,
        })
        .from(workspaceParents)
        .innerJoin(organization, eq(organization.id, workspaceParents.workspaceId))
        .where(eq(workspaceParents.parentId, scope.workspaceId))
        .orderBy(asc(workspaceParents.createdAt), asc(organization.id));
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

    async countMembers(scope: WorkspaceScope): Promise<number> {
      assertWorkspaceScope(scope);
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(member)
        .where(eq(member.organizationId, scope.workspaceId));
      return row?.n ?? 0;
    },

    /* System-level: workspaces whose trial ends in [from, to), paged by ID (trial emails). */
    async trialsEndingBetween(
      from: Date,
      to: Date,
      limit: number,
      afterId?: string,
    ): Promise<Array<{ workspaceId: string; trialEndsAt: Date }>> {
      const rows = await db
        .select({
          workspaceId: workspaceSettings.workspaceId,
          trialEndsAt: workspaceSettings.trialEndsAt,
        })
        .from(workspaceSettings)
        .where(
          and(
            gte(workspaceSettings.trialEndsAt, from),
            lt(workspaceSettings.trialEndsAt, to),
            afterId ? gt(workspaceSettings.workspaceId, afterId) : undefined,
          ),
        )
        .orderBy(asc(workspaceSettings.workspaceId))
        .limit(limit);
      return rows.flatMap((r) =>
        r.trialEndsAt === null ? [] : [{ workspaceId: r.workspaceId, trialEndsAt: r.trialEndsAt }],
      );
    },

    async workspaceName(scope: WorkspaceScope): Promise<string | undefined> {
      assertWorkspaceScope(scope);
      const rows = await db
        .select({ name: organization.name })
        .from(organization)
        .where(eq(organization.id, scope.workspaceId))
        .limit(1);
      return rows[0]?.name;
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
      patch: Partial<Pick<WorkspaceSettingsRow, "timezone" | "requireTwoFactor" | "trialEndsAt">>,
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
    async workspaceIds(limit: number, afterId?: string): Promise<string[]> {
      const rows = await db
        .select({ id: organization.id })
        .from(organization)
        .where(afterId ? gt(organization.id, afterId) : undefined)
        .orderBy(asc(organization.id))
        .limit(limit);
      return rows.map((r) => r.id);
    },

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
