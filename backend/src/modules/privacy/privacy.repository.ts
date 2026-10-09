/* Drizzle queries for this module's own tables only (tables go in schema/). */
import { asc, eq, lte } from "drizzle-orm";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import { assertWorkspaceScope } from "../../core/workspace-scope.js";
import type { Db } from "../../infra/db/index.js";
import {
  workspaceDeletions,
  workspaceErasures,
  type WorkspaceDeletionRow,
} from "./schema/workspace-deletions.js";

export type PrivacyRepository = ReturnType<typeof createPrivacyRepository>;

export function createPrivacyRepository(db: Db) {
  return {
    async findDeletion(scope: WorkspaceScope): Promise<WorkspaceDeletionRow | undefined> {
      assertWorkspaceScope(scope);
      const [row] = await db
        .select()
        .from(workspaceDeletions)
        .where(eq(workspaceDeletions.workspaceId, scope.workspaceId))
        .limit(1);
      return row;
    },

    /* False when a request was already waiting: the first one's date stands. */
    async insertDeletion(row: WorkspaceDeletionRow): Promise<boolean> {
      const inserted = await db
        .insert(workspaceDeletions)
        .values(row)
        .onConflictDoNothing()
        .returning({ workspaceId: workspaceDeletions.workspaceId });
      return inserted.length > 0;
    },

    async deleteDeletion(scope: WorkspaceScope): Promise<boolean> {
      assertWorkspaceScope(scope);
      const removed = await db
        .delete(workspaceDeletions)
        .where(eq(workspaceDeletions.workspaceId, scope.workspaceId))
        .returning({ workspaceId: workspaceDeletions.workspaceId });
      return removed.length > 0;
    },

    /* System: requests whose 30 days are over, oldest first. */
    async dueDeletions(now: Date, limit: number): Promise<WorkspaceDeletionRow[]> {
      return db
        .select()
        .from(workspaceDeletions)
        .where(lte(workspaceDeletions.deleteAfter, now))
        .orderBy(asc(workspaceDeletions.deleteAfter))
        .limit(limit);
    },

    async recordErasure(row: {
      erasedWorkspaceId: string;
      requestedAt: Date;
      erasedAt: Date;
      objects: number;
    }): Promise<void> {
      await db.insert(workspaceErasures).values(row).onConflictDoNothing();
    },
  };
}
