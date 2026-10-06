/* Queries on digest_sends, owned by the reports module. */
import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../../infra/db/index.js";
import { digestSends } from "./schema/reports.js";

export type ReportsRepository = ReturnType<typeof createReportsRepository>;

export function createReportsRepository() {
  return {
    async digestSent(tx: DbOrTx, workspaceId: string, weekStart: Date): Promise<boolean> {
      const rows = await tx
        .select({ workspaceId: digestSends.workspaceId })
        .from(digestSends)
        .where(and(eq(digestSends.workspaceId, workspaceId), eq(digestSends.weekStart, weekStart)));
      return rows.length > 0;
    },

    /* True if this call claimed the week for the workspace. */
    async claimDigest(tx: DbOrTx, workspaceId: string, weekStart: Date): Promise<boolean> {
      const rows = await tx
        .insert(digestSends)
        .values({ workspaceId, weekStart })
        .onConflictDoNothing()
        .returning({ workspaceId: digestSends.workspaceId });
      return rows.length > 0;
    },
  };
}
