/* Drizzle queries for this module's own tables only (tables go in schema/). */
import { asc, eq, sql } from "drizzle-orm";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import { tenantWhere, withWorkspace, type DbOrTx } from "../../infra/db/index.js";
import { inboundSources, type InboundSourceRow } from "./schema/inbound.js";

export type InboundRepository = ReturnType<typeof createInboundRepository>;

export function createInboundRepository() {
  return {
    async list(db: DbOrTx, scope: WorkspaceScope): Promise<InboundSourceRow[]> {
      return db
        .select()
        .from(inboundSources)
        .where(tenantWhere(scope, inboundSources))
        .orderBy(asc(inboundSources.name), asc(inboundSources.id));
    },

    async count(db: DbOrTx, scope: WorkspaceScope): Promise<number> {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(inboundSources)
        .where(tenantWhere(scope, inboundSources));
      return row?.n ?? 0;
    },

    async find(
      db: DbOrTx,
      scope: WorkspaceScope,
      id: string,
    ): Promise<InboundSourceRow | undefined> {
      const rows = await db
        .select()
        .from(inboundSources)
        .where(tenantWhere(scope, inboundSources, eq(inboundSources.id, id)))
        .limit(1);
      return rows[0];
    },

    /* Token URLs carry no workspace; the hash is unique across all of them. */
    async findByTokenHash(db: DbOrTx, tokenHash: string): Promise<InboundSourceRow | undefined> {
      const rows = await db
        .select()
        .from(inboundSources)
        .where(eq(inboundSources.tokenHash, tokenHash))
        .limit(1);
      return rows[0];
    },

    async insert(
      db: DbOrTx,
      scope: WorkspaceScope,
      row: Pick<InboundSourceRow, "id" | "name" | "kind" | "tokenHash" | "tokenHint" | "createdBy">,
    ): Promise<InboundSourceRow> {
      const [created] = await db
        .insert(inboundSources)
        .values(withWorkspace(scope, row))
        .returning();
      if (created === undefined) throw new Error("inbound source insert returned nothing");
      return created;
    },

    async setToken(
      db: DbOrTx,
      scope: WorkspaceScope,
      id: string,
      token: { tokenHash: string; tokenHint: string },
    ): Promise<InboundSourceRow | undefined> {
      const [row] = await db
        .update(inboundSources)
        .set(token)
        .where(tenantWhere(scope, inboundSources, eq(inboundSources.id, id)))
        .returning();
      return row;
    },

    async touch(db: DbOrTx, id: string, at: Date): Promise<void> {
      await db
        .update(inboundSources)
        .set({ lastReceivedAt: sql`${at.toISOString()}::timestamptz` })
        .where(eq(inboundSources.id, id));
    },

    async delete(db: DbOrTx, scope: WorkspaceScope, id: string): Promise<boolean> {
      const rows = await db
        .delete(inboundSources)
        .where(tenantWhere(scope, inboundSources, eq(inboundSources.id, id)))
        .returning({ id: inboundSources.id });
      return rows.length > 0;
    },
  };
}
