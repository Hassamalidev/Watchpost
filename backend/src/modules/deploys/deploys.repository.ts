/* Drizzle queries for deploy_hooks and deploys. Tenant reads and writes go through tenantWhere. */
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import type { DbOrTx } from "../../infra/db/index.js";
import { tenantWhere, withWorkspace } from "../../infra/db/tenancy.js";
import { deployHooks, deploys, type DeployRow } from "./schema/deploys.js";

export type DeploysRepository = ReturnType<typeof createDeploysRepository>;

export function createDeploysRepository() {
  return {
    async hook(db: DbOrTx, scope: WorkspaceScope) {
      const [row] = await db.select().from(deployHooks).where(tenantWhere(scope, deployHooks));
      return row;
    },

    /* Replaces the workspace's hook (one per workspace); concurrent rotations both succeed, last wins. */
    async replaceHook(
      db: DbOrTx,
      scope: WorkspaceScope,
      values: { id: string; tokenHash: string; createdBy: string | null },
    ) {
      await db
        .insert(deployHooks)
        .values(withWorkspace(scope, values))
        .onConflictDoUpdate({
          target: deployHooks.workspaceId,
          set: { tokenHash: values.tokenHash, createdBy: values.createdBy, createdAt: sql`now()` },
        });
    },

    /* System-level lookup for the token URL: which workspace owns this token. */
    async workspaceForToken(db: DbOrTx, tokenHash: string): Promise<string | undefined> {
      const [row] = await db
        .select({ workspaceId: deployHooks.workspaceId })
        .from(deployHooks)
        .where(eq(deployHooks.tokenHash, tokenHash));
      return row?.workspaceId;
    },

    /* Inserts a deploy; false if a GitHub retry already recorded it. */
    async insert(
      db: DbOrTx,
      scope: WorkspaceScope,
      values: Omit<typeof deploys.$inferInsert, "workspaceId" | "createdAt">,
    ): Promise<boolean> {
      const rows = await db
        .insert(deploys)
        .values(withWorkspace(scope, values))
        .onConflictDoNothing()
        .returning({ id: deploys.id });
      return rows.length > 0;
    },

    async between(
      db: DbOrTx,
      scope: WorkspaceScope,
      from: Date,
      to: Date,
      limit: number,
    ): Promise<DeployRow[]> {
      return db
        .select()
        .from(deploys)
        .where(
          tenantWhere(
            scope,
            deploys,
            and(gte(deploys.deployedAt, from), lte(deploys.deployedAt, to)),
          ),
        )
        .orderBy(desc(deploys.deployedAt))
        .limit(limit);
    },
  };
}
