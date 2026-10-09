/*
 * Erasing a workspace (PRODUCT.md §13 "Privacy"). Tables are found by their `workspace_id` column
 * and not from a list, so a table added later can't be forgotten. Most rows go when the workspace's
 * own row goes (foreign keys cascade); tables that only carry the ID are emptied one by one.
 * Not one transaction: check results can be many, and a half-erased workspace is erased again by
 * the next run. Returns the tables that still hold rows; an empty list means nothing is left.
 */
import { sql } from "drizzle-orm";
import type { Db } from "./index.js";

const NAME = /^[a-z_][a-z0-9_]*$/;
const PASSES = 4;

export async function eraseWorkspaceRows(db: Db, workspaceId: string): Promise<string[]> {
  /* Ordinary and partitioned tables; a partition is emptied through its parent. */
  const found = await db.execute<{ name: string; type: string }>(sql`
    select c.relname as name, a.atttypid::regtype::text as type
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and a.attname = 'workspace_id' and not a.attisdropped
      and c.relkind in ('r', 'p') and not c.relispartition
    order by c.relname`);
  const tables = found.rows.filter((table) => NAME.test(table.name));
  const remove = (table: { name: string; type: string }) =>
    table.type === "uuid"
      ? sql`delete from ${sql.identifier(table.name)} where workspace_id = ${workspaceId}::uuid`
      : sql`delete from ${sql.identifier(table.name)} where workspace_id = ${workspaceId}`;

  let pending = tables;
  let workspaceGone = false;
  for (let pass = 0; pass < PASSES && (pending.length > 0 || !workspaceGone); pass += 1) {
    const failed: typeof tables = [];
    for (const table of pending) {
      try {
        await db.execute(remove(table));
      } catch {
        /* Another table still points at these rows; it is emptied in this pass, so try again. */
        failed.push(table);
      }
    }
    if (!workspaceGone) {
      try {
        await db.execute(sql`delete from organization where id = ${workspaceId}::uuid`);
        workspaceGone = true;
        /* The cascade may have been what the failed tables were waiting for. */
        pending = tables;
        continue;
      } catch {
        /* A table without a cascade still points at the workspace; next pass. */
      }
    }
    pending = failed;
  }

  const left: string[] = workspaceGone ? [] : ["organization"];
  for (const table of tables) {
    const rows = await db.execute(
      table.type === "uuid"
        ? sql`select 1 from ${sql.identifier(table.name)} where workspace_id = ${workspaceId}::uuid limit 1`
        : sql`select 1 from ${sql.identifier(table.name)} where workspace_id = ${workspaceId} limit 1`,
    );
    if (rows.rows.length > 0) left.push(table.name);
  }
  return left;
}
