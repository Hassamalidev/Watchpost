/* Queries on expiry_notices, domain_expiry_cache, rdap_bootstrap and ssl_state (expiry module). */
import { and, eq, min } from "drizzle-orm";
import type { DbOrTx } from "../../infra/db/index.js";
import {
  domainExpiryCache,
  expiryNotices,
  rdapBootstrap,
  sslState,
  type DomainExpiryRow,
  type ExpiryKind,
  type SslStateRow,
} from "./schema/expiry.js";

export type ExpiryRepository = ReturnType<typeof createExpiryRepository>;

export function createExpiryRepository() {
  return {
    async noticed(
      tx: DbOrTx,
      monitorId: string,
      kind: ExpiryKind,
      subject: string,
    ): Promise<Set<number>> {
      const rows = await tx
        .select({ threshold: expiryNotices.threshold })
        .from(expiryNotices)
        .where(
          and(
            eq(expiryNotices.monitorId, monitorId),
            eq(expiryNotices.kind, kind),
            eq(expiryNotices.subject, subject),
          ),
        );
      return new Set(rows.map((r) => r.threshold));
    },

    /* Records notices; returns the thresholds this call recorded (others were already there). */
    async addNotices(
      tx: DbOrTx,
      rows: Array<typeof expiryNotices.$inferInsert>,
    ): Promise<number[]> {
      if (rows.length === 0) return [];
      const inserted = await tx
        .insert(expiryNotices)
        .values(rows)
        .onConflictDoNothing()
        .returning({ threshold: expiryNotices.threshold });
      return inserted.map((r) => r.threshold);
    },

    async domain(tx: DbOrTx, domain: string): Promise<DomainExpiryRow | undefined> {
      const rows = await tx
        .select()
        .from(domainExpiryCache)
        .where(eq(domainExpiryCache.domain, domain));
      return rows[0];
    },

    async saveDomain(tx: DbOrTx, row: DomainExpiryRow): Promise<void> {
      await tx
        .insert(domainExpiryCache)
        .values(row)
        .onConflictDoUpdate({ target: domainExpiryCache.domain, set: row });
    },

    async bootstrap(tx: DbOrTx): Promise<{ map: Map<string, string[]>; fetchedAt: Date | null }> {
      const rows = await tx.select().from(rdapBootstrap);
      const [oldest] = await tx.select({ at: min(rdapBootstrap.fetchedAt) }).from(rdapBootstrap);
      return { map: new Map(rows.map((r) => [r.tld, r.urls])), fetchedAt: oldest?.at ?? null };
    },

    async replaceBootstrap(tx: DbOrTx, map: Map<string, string[]>, at: Date): Promise<void> {
      await tx.delete(rdapBootstrap);
      const rows = [...map].map(([tld, urls]) => ({ tld, urls, fetchedAt: at }));
      for (let i = 0; i < rows.length; i += 500) {
        await tx.insert(rdapBootstrap).values(rows.slice(i, i + 500));
      }
    },

    async ssl(tx: DbOrTx, monitorId: string): Promise<SslStateRow | undefined> {
      const rows = await tx.select().from(sslState).where(eq(sslState.monitorId, monitorId));
      return rows[0];
    },

    async saveSsl(tx: DbOrTx, row: SslStateRow): Promise<void> {
      await tx
        .insert(sslState)
        .values(row)
        .onConflictDoUpdate({ target: sslState.monitorId, set: row });
    },
  };
}
