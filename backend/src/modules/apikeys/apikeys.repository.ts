/* Queries on api_keys and idempotency_keys, owned by the apikeys module. */
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import { tenantWhere, withWorkspace, type DbOrTx } from "../../infra/db/index.js";
import { apiKeys, idempotencyKeys } from "./schema/apikeys.js";

export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type IdempotencyRow = typeof idempotencyKeys.$inferSelect;

export type ApikeysRepository = ReturnType<typeof createApikeysRepository>;

export function createApikeysRepository(db: DbOrTx) {
  return {
    async list(scope: WorkspaceScope): Promise<ApiKeyRow[]> {
      return db
        .select()
        .from(apiKeys)
        .where(tenantWhere(scope, apiKeys))
        .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
    },

    /* Keys that still work count against the workspace's limit. */
    async countActive(scope: WorkspaceScope): Promise<number> {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(apiKeys)
        .where(tenantWhere(scope, apiKeys, isNull(apiKeys.revokedAt)));
      return row?.n ?? 0;
    },

    async insert(
      scope: WorkspaceScope,
      values: Omit<typeof apiKeys.$inferInsert, "workspaceId">,
    ): Promise<ApiKeyRow> {
      const rows = await db.insert(apiKeys).values(withWorkspace(scope, values)).returning();
      const row = rows[0];
      if (row === undefined) throw new Error("api key insert returned no row");
      return row;
    },

    async revoke(scope: WorkspaceScope, id: string, now: Date): Promise<ApiKeyRow | undefined> {
      const rows = await db
        .update(apiKeys)
        .set({ revokedAt: now })
        .where(tenantWhere(scope, apiKeys, eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
        .returning();
      return rows[0];
    },

    /* System: the key a request presented, before we know its workspace. */
    async findByPrefix(prefix: string): Promise<ApiKeyRow | undefined> {
      const rows = await db.select().from(apiKeys).where(eq(apiKeys.prefix, prefix)).limit(1);
      return rows[0];
    },

    /* At most one write a minute per key, however busy the key is. */
    async touch(id: string, now: Date): Promise<void> {
      await db
        .update(apiKeys)
        .set({ lastUsedAt: now })
        .where(
          and(
            eq(apiKeys.id, id),
            sql`(${apiKeys.lastUsedAt} is null or ${apiKeys.lastUsedAt} < ${new Date(now.getTime() - 60_000).toISOString()}::timestamptz)`,
          ),
        );
    },

    /* True if this call claimed the key; false when it was used before. */
    async claimIdempotencyKey(
      scope: WorkspaceScope,
      key: string,
      fingerprint: string,
      now: Date,
    ): Promise<boolean> {
      const rows = await db
        .insert(idempotencyKeys)
        .values(withWorkspace(scope, { key, fingerprint, createdAt: now }))
        .onConflictDoNothing()
        .returning({ key: idempotencyKeys.key });
      return rows.length > 0;
    },

    async findIdempotencyKey(
      scope: WorkspaceScope,
      key: string,
    ): Promise<IdempotencyRow | undefined> {
      const rows = await db
        .select()
        .from(idempotencyKeys)
        .where(
          and(eq(idempotencyKeys.workspaceId, scope.workspaceId), eq(idempotencyKeys.key, key)),
        );
      return rows[0];
    },

    async storeIdempotentAnswer(
      scope: WorkspaceScope,
      key: string,
      status: number,
      response: unknown,
    ): Promise<void> {
      await db
        .update(idempotencyKeys)
        .set({ status, response: response ?? null })
        .where(
          and(eq(idempotencyKeys.workspaceId, scope.workspaceId), eq(idempotencyKeys.key, key)),
        );
    },

    /* The request failed before it changed anything worth remembering: the key is free again. */
    async releaseIdempotencyKey(scope: WorkspaceScope, key: string): Promise<void> {
      await db
        .delete(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.workspaceId, scope.workspaceId),
            eq(idempotencyKeys.key, key),
            isNull(idempotencyKeys.status),
          ),
        );
    },

    /* System: forgets keys older than the promise we make about them. */
    async deleteIdempotencyKeysBefore(before: Date): Promise<number> {
      const rows = await db
        .delete(idempotencyKeys)
        .where(lt(idempotencyKeys.createdAt, before))
        .returning({ key: idempotencyKeys.key });
      return rows.length;
    },
  };
}
