/*
 * Drizzle queries for the credits module's tables. Tenant reads and writes go through tenantWhere and
 * withWorkspace; the provider totals at the bottom are system-level (they add up every workspace).
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import type { DbOrTx } from "../../infra/db/index.js";
import { tenantWhere, withWorkspace } from "../../infra/db/tenancy.js";
import {
  creditBalances,
  creditLedger,
  providerFunding,
  usageLedger,
  type CreditBalanceRow,
  type CreditLedgerRow,
  type FundingSource,
  type Provider,
} from "./schema/credits.js";

export type CreditsRepository = ReturnType<typeof createCreditsRepository>;

export function createCreditsRepository() {
  return {
    async balance(db: DbOrTx, scope: WorkspaceScope): Promise<CreditBalanceRow | undefined> {
      const [row] = await db
        .select()
        .from(creditBalances)
        .where(eq(creditBalances.workspaceId, scope.workspaceId))
        .limit(1);
      return row;
    },

    /* Creates the balance row if needed and locks it until the transaction ends. */
    async lockBalance(tx: DbOrTx, scope: WorkspaceScope): Promise<CreditBalanceRow> {
      await tx
        .insert(creditBalances)
        .values({ workspaceId: scope.workspaceId })
        .onConflictDoNothing({ target: creditBalances.workspaceId });
      const [row] = await tx
        .select()
        .from(creditBalances)
        .where(eq(creditBalances.workspaceId, scope.workspaceId))
        .limit(1)
        .for("update");
      if (row === undefined) throw new Error("credit balance row vanished inside a transaction");
      return row;
    },

    async updateBalance(
      tx: DbOrTx,
      scope: WorkspaceScope,
      patch: Partial<Omit<CreditBalanceRow, "workspaceId">>,
    ): Promise<void> {
      await tx
        .update(creditBalances)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(eq(creditBalances.workspaceId, scope.workspaceId));
    },

    /* Appends a ledger entry; false when the same entry already exists (a retry). */
    async appendLedger(
      tx: DbOrTx,
      scope: WorkspaceScope,
      entry: Omit<typeof creditLedger.$inferInsert, "workspaceId">,
    ): Promise<boolean> {
      const rows = await tx
        .insert(creditLedger)
        .values(withWorkspace(scope, entry))
        .onConflictDoNothing()
        .returning({ id: creditLedger.id });
      return rows.length > 0;
    },

    async ledgerByRef(
      db: DbOrTx,
      scope: WorkspaceScope,
      reason: CreditLedgerRow["reason"],
      refId: string,
    ): Promise<CreditLedgerRow[]> {
      return db
        .select()
        .from(creditLedger)
        .where(
          tenantWhere(
            scope,
            creditLedger,
            and(eq(creditLedger.reason, reason), eq(creditLedger.refId, refId)),
          ),
        );
    },

    /* Charges made for an incident (false-alarm refunds look these up). */
    async chargesForIncident(
      db: DbOrTx,
      scope: WorkspaceScope,
      incidentId: string,
    ): Promise<CreditLedgerRow[]> {
      return db
        .select()
        .from(creditLedger)
        .where(
          tenantWhere(
            scope,
            creditLedger,
            and(eq(creditLedger.reason, "charge"), eq(creditLedger.incidentId, incidentId)),
          ),
        );
    },

    async recentLedger(
      db: DbOrTx,
      scope: WorkspaceScope,
      limit: number,
    ): Promise<CreditLedgerRow[]> {
      return db
        .select()
        .from(creditLedger)
        .where(tenantWhere(scope, creditLedger))
        .orderBy(desc(creditLedger.createdAt), desc(creditLedger.id))
        .limit(limit);
    },

    /* Sum of every ledger entry per bucket; equals the balance row (tests assert it). */
    async ledgerTotals(
      db: DbOrTx,
      scope: WorkspaceScope,
    ): Promise<{ included: number; purchased: number }> {
      const rows = await db
        .select({
          bucket: creditLedger.bucket,
          total: sql<number>`sum(${creditLedger.delta})::int`,
        })
        .from(creditLedger)
        .where(tenantWhere(scope, creditLedger))
        .groupBy(creditLedger.bucket);
      const of = (bucket: string) => rows.find((r) => r.bucket === bucket)?.total ?? 0;
      return { included: of("included"), purchased: of("purchased") };
    },

    /* Meters one provider call; false when this call was already metered. */
    async insertUsage(
      db: DbOrTx,
      scope: WorkspaceScope,
      row: Omit<typeof usageLedger.$inferInsert, "workspaceId">,
    ): Promise<boolean> {
      const rows = await db
        .insert(usageLedger)
        .values(withWorkspace(scope, row))
        .onConflictDoNothing({ target: [usageLedger.provider, usageLedger.ref] })
        .returning({ id: usageLedger.id });
      return rows.length > 0;
    },

    /* What one workspace cost us at a provider since `since`, in micro-USD. */
    async usageSince(
      db: DbOrTx,
      scope: WorkspaceScope,
      provider: Provider,
      since: Date,
    ): Promise<number> {
      const [row] = await db
        .select({ total: sql<string | null>`sum(${usageLedger.costMicros})` })
        .from(usageLedger)
        .where(
          tenantWhere(
            scope,
            usageLedger,
            and(eq(usageLedger.provider, provider), gte(usageLedger.createdAt, since)),
          ),
        );
      return Number(row?.total ?? 0);
    },

    /*
     * Records what a payment set aside for a provider. A plan upgrade inside the same window raises
     * the amount; it never goes down.
     */
    async upsertFunding(
      tx: DbOrTx,
      scope: WorkspaceScope,
      row: {
        id: string;
        provider: Provider;
        source: FundingSource;
        ref: string;
        amountMicros: number;
        periodStart: Date;
        periodEnd: Date | null;
      },
    ): Promise<void> {
      await tx
        .insert(providerFunding)
        .values(withWorkspace(scope, row))
        .onConflictDoUpdate({
          target: [providerFunding.provider, providerFunding.ref],
          set: {
            amountMicros: sql`greatest(${providerFunding.amountMicros}, excluded.amount_micros)`,
          },
        });
    },

    /* System-level: every provider's spend since `since`, split by who paid for it. */
    async providerSpend(
      db: DbOrTx,
      since: Date,
    ): Promise<Array<{ provider: Provider; funded: boolean; costMicros: number }>> {
      const rows = await db
        .select({
          provider: usageLedger.provider,
          funded: usageLedger.funded,
          total: sql<string>`sum(${usageLedger.costMicros})`,
        })
        .from(usageLedger)
        .where(gte(usageLedger.createdAt, since))
        .groupBy(usageLedger.provider, usageLedger.funded);
      return rows.map((r) => ({
        provider: r.provider,
        funded: r.funded,
        costMicros: Number(r.total),
      }));
    },

    /* System-level: platform-paid spend at a provider since `since` (free and trial workspaces). */
    async unfundedSpend(db: DbOrTx, provider: Provider, since: Date): Promise<number> {
      const [row] = await db
        .select({ total: sql<string | null>`sum(${usageLedger.costMicros})` })
        .from(usageLedger)
        .where(
          and(
            eq(usageLedger.provider, provider),
            eq(usageLedger.funded, false),
            gte(usageLedger.createdAt, since),
          ),
        );
      return Number(row?.total ?? 0);
    },

    /* System-level: credits customers hold right now (expired included credits don't count). */
    async outstandingCredits(db: DbOrTx, now: Date): Promise<number> {
      const [row] = await db
        .select({
          total: sql<string | null>`sum(${creditBalances.purchased} + case
            when ${creditBalances.includedExpiresAt} is null
              or ${creditBalances.includedExpiresAt} > ${now.toISOString()}::timestamptz
            then ${creditBalances.included} else 0 end)`,
        })
        .from(creditBalances);
      return Number(row?.total ?? 0);
    },

    /*
     * System-level: what current funding windows of a provider still owe, in micro-USD: each window's
     * amount minus what the workspace already spent inside it.
     */
    async unspentFunding(db: DbOrTx, provider: Provider, now: Date): Promise<number> {
      const at = sql`${now.toISOString()}::timestamptz`;
      const result = await db.execute<{ total: string | null }>(sql`
        select sum(greatest(f.amount_micros - coalesce(u.spent, 0), 0)) as total
        from ${providerFunding} f
        left join lateral (
          select sum(ul.cost_micros) as spent
          from ${usageLedger} ul
          where ul.workspace_id = f.workspace_id
            and ul.provider = f.provider
            and ul.created_at >= f.period_start
        ) u on true
        where f.provider = ${provider}
          and f.period_start <= ${at}
          and f.period_end > ${at}`);
      return Number(result.rows[0]?.total ?? 0);
    },
  };
}
