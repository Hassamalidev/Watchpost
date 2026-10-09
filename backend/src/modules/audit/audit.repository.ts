/* Queries on audit_logs, owned by the audit module. */
import { and, desc, eq, gte, lt } from "drizzle-orm";
import type { AuditCategory } from "@app/shared";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import { tenantWhere, type DbOrTx } from "../../infra/db/index.js";
import { auditLogs } from "./schema/audit.js";

export type AuditRow = typeof auditLogs.$inferSelect;

export type AuditRepository = ReturnType<typeof createAuditRepository>;

export function createAuditRepository(db: DbOrTx) {
  return {
    async insert(row: typeof auditLogs.$inferInsert): Promise<void> {
      await db.insert(auditLogs).values(row);
    },

    /* Newest first. `before` is the ID of the last entry of the page before. */
    async list(
      scope: WorkspaceScope,
      filters: {
        limit: number;
        before?: string | undefined;
        category?: AuditCategory | undefined;
        since?: Date | undefined;
      },
    ): Promise<AuditRow[]> {
      return db
        .select()
        .from(auditLogs)
        .where(
          tenantWhere(
            scope,
            auditLogs,
            and(
              filters.before === undefined ? undefined : lt(auditLogs.id, filters.before),
              filters.category === undefined ? undefined : eq(auditLogs.category, filters.category),
              filters.since === undefined ? undefined : gte(auditLogs.at, filters.since),
            ),
          ),
        )
        .orderBy(desc(auditLogs.id))
        .limit(filters.limit);
    },

    async deleteBefore(before: Date): Promise<number> {
      const rows = await db
        .delete(auditLogs)
        .where(lt(auditLogs.at, before))
        .returning({ id: auditLogs.id });
      return rows.length;
    },
  };
}
