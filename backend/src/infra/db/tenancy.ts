/*
 * Tenancy helpers for repositories (PRODUCT.md §8, §12): every tenant query filters by
 * workspace_id taken from a WorkspaceScope, and every insert gets its workspace_id from the scope,
 * never from caller-supplied values. Repositories use these instead of writing the filter by hand.
 */
import { and, eq, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { assertWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import type { DbOrTx } from "./pool.js";

export type TenantTable = PgTable & { id: AnyPgColumn; workspaceId: AnyPgColumn };

/* `WHERE workspace_id = scope AND ...conditions` */
export function tenantWhere(
  scope: WorkspaceScope,
  table: TenantTable,
  ...conditions: Array<SQL | undefined>
): SQL {
  assertWorkspaceScope(scope);
  const where = and(eq(table.workspaceId, scope.workspaceId), ...conditions);
  if (where === undefined) throw new Error("unreachable: tenant filter is always present");
  return where;
}

/* Sets workspaceId from the scope, overriding anything the caller passed. */
export function withWorkspace<T extends object>(
  scope: WorkspaceScope,
  values: T,
): Omit<T, "workspaceId"> & { workspaceId: string } {
  assertWorkspaceScope(scope);
  return { ...values, workspaceId: scope.workspaceId };
}

/*
 * Generic CRUD for a tenant table. Modules wrap it in their own repository and add
 * module-specific queries using tenantWhere.
 */
export function createTenantRepository<T extends TenantTable>(table: T) {
  type Row = T["$inferSelect"];
  type Insert = Omit<T["$inferInsert"], "workspaceId">;

  return {
    async findById(db: DbOrTx, scope: WorkspaceScope, id: string): Promise<Row | undefined> {
      const rows = await db
        .select()
        .from(table as PgTable)
        .where(tenantWhere(scope, table, eq(table.id, id)))
        .limit(1);
      return rows[0] as Row | undefined;
    },

    async list(db: DbOrTx, scope: WorkspaceScope, where?: SQL): Promise<Row[]> {
      const rows = await db
        .select()
        .from(table as PgTable)
        .where(tenantWhere(scope, table, where));
      return rows as Row[];
    },

    async insert(db: DbOrTx, scope: WorkspaceScope, values: Insert): Promise<Row> {
      const rows = await db
        .insert(table)
        .values(withWorkspace(scope, values) as T["$inferInsert"])
        .returning();
      return (rows as Row[])[0] as Row;
    },

    async update(
      db: DbOrTx,
      scope: WorkspaceScope,
      id: string,
      values: Partial<Insert>,
    ): Promise<Row | undefined> {
      const { workspaceId: _ignored, ...safe } = values as Partial<Insert> & {
        workspaceId?: unknown;
      };
      const rows = await db
        .update(table)
        .set(safe as Partial<T["$inferInsert"]>)
        .where(tenantWhere(scope, table, eq(table.id, id)))
        .returning();
      return (rows as Row[])[0];
    },

    async delete(db: DbOrTx, scope: WorkspaceScope, id: string): Promise<boolean> {
      const rows = await db
        .delete(table)
        .where(tenantWhere(scope, table, eq(table.id, id)))
        .returning({ id: table.id });
      return rows.length > 0;
    },
  };
}
