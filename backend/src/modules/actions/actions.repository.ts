/* Queries on action_tokens, owned by the actions module. */
import { eq } from "drizzle-orm";
import type { DbOrTx } from "../../infra/db/index.js";
import { actionTokens } from "./schema/actions.js";

export type ActionsRepository = ReturnType<typeof createActionsRepository>;

export function createActionsRepository() {
  return {
    async isUsed(tx: DbOrTx, nonce: string): Promise<boolean> {
      const rows = await tx
        .select({ nonce: actionTokens.nonce })
        .from(actionTokens)
        .where(eq(actionTokens.nonce, nonce));
      return rows.length > 0;
    },

    /* Records a use; false if the nonce was used before. */
    async markUsed(tx: DbOrTx, row: typeof actionTokens.$inferInsert): Promise<boolean> {
      const inserted = await tx
        .insert(actionTokens)
        .values(row)
        .onConflictDoNothing()
        .returning({ nonce: actionTokens.nonce });
      return inserted.length > 0;
    },
  };
}
