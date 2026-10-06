/* Drizzle queries for this module's own tables only (tables go in schema/). */
import { desc } from "drizzle-orm";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import { tenantWhere, withWorkspace, type DbOrTx } from "../../infra/db/index.js";
import { imports, type ImportRow } from "./schema/imports.js";

export type ImportsRepository = ReturnType<typeof createImportsRepository>;

export function createImportsRepository() {
  return {
    async insert(
      db: DbOrTx,
      scope: WorkspaceScope,
      row: Pick<
        ImportRow,
        "id" | "source" | "items" | "total" | "mapped" | "created" | "failed" | "createdBy"
      >,
    ): Promise<ImportRow> {
      const [created] = await db.insert(imports).values(withWorkspace(scope, row)).returning();
      if (created === undefined) throw new Error("import insert returned nothing");
      return created;
    },

    async list(db: DbOrTx, scope: WorkspaceScope, limit: number): Promise<ImportRow[]> {
      return db
        .select()
        .from(imports)
        .where(tenantWhere(scope, imports))
        .orderBy(desc(imports.createdAt), desc(imports.id))
        .limit(limit);
    },
  };
}
