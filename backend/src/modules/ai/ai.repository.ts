/* Drizzle queries for this module's own tables only (tables go in schema/). */
import { and, desc, eq } from "drizzle-orm";
import type { AiFeedback } from "@app/shared";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import { tenantWhere, withWorkspace, type DbOrTx } from "../../infra/db/index.js";
import { aiGenerations, type AiGenerationRow } from "./schema/ai.js";

export type AiRepository = ReturnType<typeof createAiRepository>;

type NewGeneration = Pick<
  AiGenerationRow,
  | "id"
  | "kind"
  | "promptVersion"
  | "refId"
  | "model"
  | "status"
  | "reason"
  | "inputTokens"
  | "outputTokens"
  | "costMicros"
  | "output"
  | "createdAt"
>;

export function createAiRepository(db: DbOrTx) {
  return {
    async insert(scope: WorkspaceScope, row: NewGeneration): Promise<AiGenerationRow> {
      const [created] = await db
        .insert(aiGenerations)
        .values(withWorkspace(scope, row))
        .returning();
      if (created === undefined) throw new Error("ai generation insert returned nothing");
      return created;
    },

    /* The newest stored answer of a kind about one thing. */
    async latestOk(
      scope: WorkspaceScope,
      kind: string,
      refId: string,
    ): Promise<AiGenerationRow | undefined> {
      const rows = await db
        .select()
        .from(aiGenerations)
        .where(
          tenantWhere(
            scope,
            aiGenerations,
            and(
              eq(aiGenerations.kind, kind),
              eq(aiGenerations.refId, refId),
              eq(aiGenerations.status, "ok"),
            ),
          ),
        )
        .orderBy(desc(aiGenerations.createdAt), desc(aiGenerations.id))
        .limit(1);
      return rows[0];
    },

    async find(scope: WorkspaceScope, id: string): Promise<AiGenerationRow | undefined> {
      const rows = await db
        .select()
        .from(aiGenerations)
        .where(tenantWhere(scope, aiGenerations, eq(aiGenerations.id, id)))
        .limit(1);
      return rows[0];
    },

    async setFeedback(
      scope: WorkspaceScope,
      id: string,
      feedback: AiFeedback | null,
      by: string | null,
    ): Promise<AiGenerationRow | undefined> {
      const [row] = await db
        .update(aiGenerations)
        .set({ feedback, feedbackBy: feedback === null ? null : by })
        .where(
          tenantWhere(
            scope,
            aiGenerations,
            and(eq(aiGenerations.id, id), eq(aiGenerations.status, "ok")),
          ),
        )
        .returning();
      return row;
    },
  };
}
