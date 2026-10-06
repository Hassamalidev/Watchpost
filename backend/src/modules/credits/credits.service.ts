/*
 * Credits and upstream funding (PRODUCT.md §5, §11 "Upstream funding").
 *
 * The rule this file enforces: we spend at a provider only against money a customer already paid.
 * - A collected subscription payment grants the month's SMS and voice credits and sets aside the
 *   month's AI budget. A paid credit pack adds credits that never expire. Free and trial workspaces
 *   get no SMS credits; their small AI allowance is capped for all of them together.
 * - `charge` takes credits before a paid message is sent (included credits first, then purchased) and
 *   refuses when there are not enough. `aiBudget` answers whether an AI call may be made.
 * - Every grant, purchase, charge, refund and expiry is a ledger entry; the balance row is the sum of
 *   the ledger. Each operation is idempotent by its reference, so retried jobs change nothing.
 * - `fundingStatus` adds up what all customers have paid for and not used yet, per provider, which is
 *   what our prepaid balance there must cover. Providers top themselves up by auto-reload (they sell
 *   no balance by API); where one reports its balance we compare and warn the owner.
 */
import type { CreditBucket, CreditLedgerEntry, CreditsState } from "@app/shared";
import type { Clock } from "../../core/clock.js";
import { ValidationError } from "../../core/errors.js";
import { createWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import { CREDIT_PROVIDER_COST_MICROS, PAST_DUE_GRACE_DAYS, PLANS } from "../../config/plans.js";
import type { Db, Tx } from "../../infra/db/index.js";
import type { ProviderBalanceReader } from "../../infra/funding/index.js";
import type { Locks } from "../../infra/locks.js";
import type { Logger } from "../../infra/logger.js";
import type { Outbox } from "../../infra/outbox/index.js";
import type { BillingService } from "../billing/index.js";
import type { CreditsRepository } from "./credits.repository.js";
import { grantWindow } from "./grant-window.js";
import type { CreditBalanceRow, CreditLedgerRow, Provider } from "./schema/credits.js";

export type ChargeResult =
  | { ok: true; alreadyCharged: boolean; remaining: number }
  /* Not enough credits: nothing was taken, and the paid message must not be sent. */
  | { ok: false; balance: number };

export interface AiBudget {
  allowed: boolean;
  /* `disabled`: the global kill switch. `platform_cap`: the shared allowance of unpaid workspaces. */
  reason: "ok" | "disabled" | "budget_used" | "platform_cap";
  /* True when a collected payment covers the workspace right now. */
  funded: boolean;
  budgetMicros: number;
  spentMicros: number;
  remainingMicros: number;
  periodStart: string;
}

export interface UsageInput {
  provider: Provider;
  kind: string;
  units: number;
  costMicros: number;
  /* The provider call being metered (a delivery ID, a generation ID). */
  ref: string;
}

export interface ProviderFundingStatus {
  provider: Provider;
  /* Paid for by customers and not used yet. */
  committedMicros: number;
  /* What unpaid workspaces may still use this month (AI only). */
  platformAllowanceMicros: number;
  /* What our balance at the provider must cover: the two above together. */
  requiredMicros: number;
  spentThisMonthMicros: number;
  unfundedThisMonthMicros: number;
  /* Null when the provider doesn't report a balance or couldn't be reached. */
  balanceMicros: number | null;
  shortfallMicros: number | null;
}

export interface CreditsService {
  state(scope: WorkspaceScope): Promise<CreditsState>;
  /* Takes credits for one paid message. Idempotent by `refId`. */
  charge(
    scope: WorkspaceScope,
    input: { credits: number; refId: string; incidentId?: string | undefined },
  ): Promise<ChargeResult>;
  /* Gives back every credit charged for an incident (false alarm, §5). Returns credits refunded. */
  refundIncident(scope: WorkspaceScope, incidentId: string): Promise<number>;
  /*
   * Gives back one charge whose message was never sent (the delivery failed for good). Returns the
   * credits refunded. The charge stays used up: the same `refId` can't be sent for free later.
   */
  refundCharge(scope: WorkspaceScope, refId: string): Promise<number>;
  /* Meters one provider call. False when it was already metered. */
  recordUsage(scope: WorkspaceScope, input: UsageInput): Promise<boolean>;
  /* Whether the workspace may make an AI call now, and how much budget is left. */
  aiBudget(scope: WorkspaceScope): Promise<AiBudget>;

  /* System: grants the current month's credits and funding if a collected payment covers it. */
  grantDue(workspaceId: string): Promise<number>;
  /* System: adds a paid credit pack. False when the transaction was already applied. */
  addPurchased(workspaceId: string, transactionId: string, credits: number): Promise<boolean>;
  /* System: monthly grants for every paid subscription (annual plans get one each month). */
  grantSweep(): Promise<number>;
  /* System: what each provider's balance must cover, and what it holds where known. */
  fundingStatus(): Promise<ProviderFundingStatus[]>;
  /* System: `fundingStatus` plus a warning to the owner when a balance is short. */
  checkFunding(): Promise<ProviderFundingStatus[]>;
}

const DAY_MS = 86_400_000;
const SWEEP_PAGE = 200;
const RECENT_ENTRIES = 20;
/* Warn below a fifth of the monthly allowance, and never later than this many credits. */
/*
 * What is left of a month's allowance stays usable this long after the month ends, unless the next
 * grant replaces it first. A renewal is charged at the period end and its webhook arrives a little
 * later, and a failed payment is retried for days; alerts must not lose SMS in that gap. These are
 * credits the customer already paid for, not new ones.
 */
const INCLUDED_CREDITS_GRACE_MS = PAST_DUE_GRACE_DAYS * 86_400_000;
const LOW_BALANCE_SHARE = 0.2;
const LOW_BALANCE_MIN = 5;
const PROVIDERS: Provider[] = ["anthropic", "twilio"];

export const lowBalanceThreshold = (monthlyAllowance: number) =>
  Math.max(LOW_BALANCE_MIN, Math.ceil(monthlyAllowance * LOW_BALANCE_SHARE));

const monthStartUtc = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

export function createCreditsService(deps: {
  db: Db;
  repository: CreditsRepository;
  billing: Pick<BillingService, "paidSubscription" | "paidSubscriptions" | "notifyContacts">;
  outbox: Outbox;
  clock: Clock;
  logger: Logger;
  newId: () => string;
  locks: Pick<Locks, "acquire">;
  funding: { aiEnabled: boolean; unfundedAiCapMicros: number; opsEmail: string | undefined };
  balanceReaders: ProviderBalanceReader[];
}): CreditsService {
  const { repository: repo, clock } = deps;
  const system = (workspaceId: string) => createWorkspaceScope({ workspaceId });

  const includedNow = (row: CreditBalanceRow | undefined, now: Date) =>
    row === undefined ||
    (row.includedExpiresAt !== null && row.includedExpiresAt.getTime() <= now.getTime())
      ? 0
      : row.included;

  /* Writes off included credits whose month is over. Returns the row as it is afterwards. */
  async function settle(
    tx: Tx,
    scope: WorkspaceScope,
    row: CreditBalanceRow,
    now: Date,
  ): Promise<CreditBalanceRow> {
    if (
      row.included === 0 ||
      row.includedExpiresAt === null ||
      row.includedExpiresAt.getTime() > now.getTime()
    ) {
      return row;
    }
    await append(tx, scope, {
      bucket: "included",
      delta: -row.included,
      reason: "expire",
      refId: `expired:${row.grantRef ?? row.includedExpiresAt.toISOString()}`,
      balanceAfter: 0,
    });
    await repo.updateBalance(tx, scope, { included: 0 });
    return { ...row, included: 0 };
  }

  /* Ledger entries are stamped with the injected clock, the same one grant windows are cut with. */
  const append = (
    tx: Tx,
    scope: WorkspaceScope,
    entry: Omit<Parameters<CreditsRepository["appendLedger"]>[2], "id" | "createdAt">,
  ) => repo.appendLedger(tx, scope, { ...entry, id: deps.newId(), createdAt: clock.now() });

  const toEntry = (row: CreditLedgerRow): CreditLedgerEntry => ({
    id: row.id,
    delta: row.delta,
    bucket: row.bucket,
    reason: row.reason,
    balanceAfter: row.balanceAfter,
    createdAt: row.createdAt.toISOString(),
  });

  /* Gives back the listed charges, once each. Returns the credits refunded. */
  function refundCharges(
    scope: WorkspaceScope,
    find: (tx: Tx) => Promise<CreditLedgerRow[]>,
  ): Promise<number> {
    return deps.db.transaction(async (tx) => {
      const now = clock.now();
      let row = await settle(tx, scope, await repo.lockBalance(tx, scope), now);
      let refunded = 0;
      for (const charge of await find(tx)) {
        /*
         * One refund per charge, whichever bucket it went back to: an incident can be marked,
         * cleared and marked again after the month has turned.
         */
        if ((await repo.ledgerByRef(tx, scope, "refund", charge.id)).length > 0) continue;
        const amount = -charge.delta;
        /*
         * Included credits go back to the month they came from. If that month is over, the customer
         * keeps them as purchased credits instead of losing the refund.
         */
        const sameGrant =
          charge.bucket === "included" &&
          row.includedGrantedAt !== null &&
          charge.createdAt.getTime() >= row.includedGrantedAt.getTime() &&
          row.includedExpiresAt !== null &&
          row.includedExpiresAt.getTime() > now.getTime();
        const bucket: CreditBucket = sameGrant ? "included" : "purchased";
        const balanceAfter = (bucket === "included" ? row.included : row.purchased) + amount;
        const added = await append(tx, scope, {
          bucket,
          delta: amount,
          reason: "refund",
          /* The charged entry: one refund per charge, however often the incident is re-marked. */
          refId: charge.id,
          incidentId: charge.incidentId,
          balanceAfter,
        });
        if (!added) continue;
        row = { ...row, [bucket]: balanceAfter };
        refunded += amount;
      }
      if (refunded > 0) {
        await repo.updateBalance(tx, scope, { included: row.included, purchased: row.purchased });
      }
      return refunded;
    });
  }

  const service: CreditsService = {
    async state(scope) {
      const now = clock.now();
      const [row, paid, recent] = await Promise.all([
        repo.balance(deps.db, scope),
        deps.billing.paidSubscription(scope),
        repo.recentLedger(deps.db, scope, RECENT_ENTRIES),
      ]);
      const included = includedNow(row, now);
      const purchased = row?.purchased ?? 0;
      const monthlyAllowance = paid === null ? 0 : PLANS[paid.plan].limits.monthlyCredits;
      const total = included + purchased;
      return {
        included,
        purchased,
        total,
        monthlyAllowance,
        /* A workspace that never had credits isn't "low"; it simply has none. */
        lowBalance:
          (monthlyAllowance > 0 || recent.length > 0) &&
          total < lowBalanceThreshold(monthlyAllowance),
        recent: recent.map(toEntry),
      };
    },

    async charge(scope, { credits, refId, incidentId }) {
      if (!Number.isInteger(credits) || credits <= 0) {
        throw new ValidationError("A charge needs a positive whole number of credits.");
      }
      return deps.db.transaction(async (tx) => {
        const now = clock.now();
        const row = await settle(tx, scope, await repo.lockBalance(tx, scope), now);
        const total = row.included + row.purchased;
        const earlier = await repo.ledgerByRef(tx, scope, "charge", refId);
        if (earlier.length > 0) {
          /* A charge that was given back paid for nothing: the message may not go out on it. */
          for (const entry of earlier) {
            if ((await repo.ledgerByRef(tx, scope, "refund", entry.id)).length > 0) {
              return { ok: false, balance: total };
            }
          }
          return { ok: true, alreadyCharged: true, remaining: total };
        }
        if (total < credits) return { ok: false, balance: total };

        const parts: Array<[CreditBucket, number, number]> = [];
        const fromIncluded = Math.min(row.included, credits);
        if (fromIncluded > 0) parts.push(["included", fromIncluded, row.included - fromIncluded]);
        const fromPurchased = credits - fromIncluded;
        if (fromPurchased > 0) {
          parts.push(["purchased", fromPurchased, row.purchased - fromPurchased]);
        }
        for (const [bucket, amount, balanceAfter] of parts) {
          await append(tx, scope, {
            bucket,
            delta: -amount,
            reason: "charge",
            refId,
            incidentId: incidentId ?? null,
            balanceAfter,
          });
        }
        const remaining = total - credits;
        const warn = row.lowNotifiedAt === null && remaining < lowBalanceThreshold(row.granted);
        await repo.updateBalance(tx, scope, {
          included: row.included - fromIncluded,
          purchased: row.purchased - fromPurchased,
          ...(warn ? { lowNotifiedAt: now } : {}),
        });
        if (warn) {
          await deps.billing.notifyContacts(
            tx,
            scope.workspaceId,
            "credits_low",
            { credits: remaining },
            `credits-low:${scope.workspaceId}:${now.toISOString()}`,
          );
        }
        return { ok: true, alreadyCharged: false, remaining };
      });
    },

    refundIncident: (scope, incidentId) =>
      refundCharges(scope, (tx) => repo.chargesForIncident(tx, scope, incidentId)),

    refundCharge: (scope, refId) =>
      refundCharges(scope, (tx) => repo.ledgerByRef(tx, scope, "charge", refId)),

    async recordUsage(scope, input) {
      const funded = (await deps.billing.paidSubscription(scope)) !== null;
      return repo.insertUsage(deps.db, scope, {
        id: deps.newId(),
        provider: input.provider,
        kind: input.kind,
        units: input.units,
        costMicros: input.costMicros,
        ref: input.ref,
        funded,
        createdAt: clock.now(),
      });
    },

    async aiBudget(scope) {
      const now = clock.now();
      const paid = await deps.billing.paidSubscription(scope);
      const window =
        paid === null ? null : grantWindow(paid.paidPeriodStart, paid.paidPeriodEnd, now);
      const funded = paid !== null && window !== null;
      const periodStart = funded ? window.start : monthStartUtc(now);
      /* Without a collected payment the trial's Pro plan doesn't raise the budget: Free's applies. */
      const budgetMicros = funded ? PLANS[paid.plan].aiBudgetMicros : PLANS.free.aiBudgetMicros;
      const spentMicros = await repo.usageSince(deps.db, scope, "anthropic", periodStart);
      const base = {
        funded,
        budgetMicros,
        spentMicros,
        remainingMicros: Math.max(0, budgetMicros - spentMicros),
        periodStart: periodStart.toISOString(),
      };
      if (!deps.funding.aiEnabled) return { ...base, allowed: false, reason: "disabled" };
      if (spentMicros >= budgetMicros) return { ...base, allowed: false, reason: "budget_used" };
      if (!funded) {
        const platformSpent = await repo.unfundedSpend(deps.db, "anthropic", monthStartUtc(now));
        if (platformSpent >= deps.funding.unfundedAiCapMicros) {
          return { ...base, allowed: false, reason: "platform_cap" };
        }
      }
      return { ...base, allowed: true, reason: "ok" };
    },

    async grantDue(workspaceId) {
      const scope = system(workspaceId);
      const paid = await deps.billing.paidSubscription(scope);
      if (paid === null) return 0;
      const now = clock.now();
      const window = grantWindow(paid.paidPeriodStart, paid.paidPeriodEnd, now);
      if (window === null) return 0;
      const allowance = PLANS[paid.plan].limits.monthlyCredits;
      const ref = `${paid.id}:${window.start.toISOString()}`;
      /* The common case costs one read: this month's grant is already in place. */
      const current = await repo.balance(deps.db, scope);
      if (current?.grantRef === ref && current.granted >= allowance) return 0;

      return deps.db.transaction(async (tx) => {
        const row = await settle(tx, scope, await repo.lockBalance(tx, scope), now);
        let added = 0;
        if (row.grantRef !== ref) {
          /* This window was granted before (the clock moved back): leave the balance alone. */
          if ((await repo.ledgerByRef(tx, scope, "grant", ref)).length > 0) return 0;
          if (row.included > 0) {
            /* The new month starts before the old credits expired on their own. */
            await append(tx, scope, {
              bucket: "included",
              delta: -row.included,
              reason: "expire",
              refId: `replaced:${ref}`,
              balanceAfter: 0,
            });
          }
          const granted =
            allowance > 0 &&
            (await append(tx, scope, {
              bucket: "included",
              delta: allowance,
              reason: "grant",
              refId: ref,
              balanceAfter: allowance,
            }));
          added = granted ? allowance : 0;
          await repo.updateBalance(tx, scope, {
            included: added,
            grantRef: ref,
            granted: allowance,
            includedGrantedAt: now,
            includedExpiresAt: new Date(window.end.getTime() + INCLUDED_CREDITS_GRACE_MS),
            lowNotifiedAt: null,
          });
        } else if (allowance > row.granted) {
          /*
           * An upgrade inside the month tops the allowance up for the part of the month that is
           * left, like the prorated price the customer paid for it.
           */
          const length = window.end.getTime() - window.start.getTime();
          const left = Math.max(0, window.end.getTime() - now.getTime());
          const difference = Math.round(((allowance - row.granted) * left) / length);
          const granted =
            difference > 0 &&
            (await append(tx, scope, {
              bucket: "included",
              delta: difference,
              reason: "grant_upgrade",
              refId: `${ref}:${allowance}`,
              balanceAfter: row.included + difference,
            }));
          added = granted ? difference : 0;
          await repo.updateBalance(tx, scope, {
            included: row.included + added,
            granted: allowance,
            lowNotifiedAt: null,
          });
        }
        /* The same payment funds the provider budgets this month's usage will draw on. */
        const funding: Array<[Provider, number]> = [
          ["anthropic", PLANS[paid.plan].aiBudgetMicros],
          ["twilio", allowance * CREDIT_PROVIDER_COST_MICROS],
        ];
        for (const [provider, amountMicros] of funding) {
          await repo.upsertFunding(tx, scope, {
            id: deps.newId(),
            provider,
            source: "subscription",
            ref,
            amountMicros,
            periodStart: window.start,
            periodEnd: window.end,
          });
        }
        return added;
      });
    },

    async addPurchased(workspaceId, transactionId, credits) {
      const scope = system(workspaceId);
      return deps.db.transaction(async (tx) => {
        const now = clock.now();
        const row = await settle(tx, scope, await repo.lockBalance(tx, scope), now);
        const added = await append(tx, scope, {
          bucket: "purchased",
          delta: credits,
          reason: "purchase",
          refId: transactionId,
          balanceAfter: row.purchased + credits,
        });
        if (!added) return false;
        await repo.updateBalance(tx, scope, {
          purchased: row.purchased + credits,
          lowNotifiedAt: null,
        });
        await repo.upsertFunding(tx, scope, {
          id: deps.newId(),
          provider: "twilio",
          source: "credit_pack",
          ref: transactionId,
          amountMicros: credits * CREDIT_PROVIDER_COST_MICROS,
          periodStart: now,
          periodEnd: null,
        });
        return true;
      });
    },

    async grantSweep() {
      let granted = 0;
      let afterId: string | undefined;
      for (;;) {
        const page = await deps.billing.paidSubscriptions({ afterId, limit: SWEEP_PAGE });
        for (const subscription of page.subscriptions) {
          try {
            if ((await service.grantDue(subscription.workspaceId)) > 0) granted += 1;
          } catch (err) {
            deps.logger.warn(
              { err, workspaceId: subscription.workspaceId },
              "could not grant monthly credits",
            );
          }
        }
        if (page.nextAfterId === null) return granted;
        afterId = page.nextAfterId;
      }
    },

    async fundingStatus() {
      const now = clock.now();
      const month = monthStartUtc(now);
      const [spend, credits, aiUnspent, aiPlatformSpent] = await Promise.all([
        repo.providerSpend(deps.db, month),
        repo.outstandingCredits(deps.db, now),
        repo.unspentFunding(deps.db, "anthropic", now),
        repo.unfundedSpend(deps.db, "anthropic", month),
      ]);
      const committed: Record<Provider, number> = {
        anthropic: aiUnspent,
        /* Every credit a customer holds may be spent tomorrow. */
        twilio: credits * CREDIT_PROVIDER_COST_MICROS,
      };
      const platformAllowance: Record<Provider, number> = {
        anthropic: deps.funding.aiEnabled
          ? Math.max(0, deps.funding.unfundedAiCapMicros - aiPlatformSpent)
          : 0,
        twilio: 0,
      };
      return Promise.all(
        PROVIDERS.map(async (provider) => {
          const reader = deps.balanceReaders.find((r) => r.provider === provider);
          let balanceMicros: number | null = null;
          try {
            balanceMicros = (await reader?.balanceMicros()) ?? null;
          } catch (err) {
            deps.logger.warn({ err, provider }, "could not read the provider balance");
          }
          const spentOf = (funded?: boolean) =>
            spend
              .filter(
                (s) => s.provider === provider && (funded === undefined || s.funded === funded),
              )
              .reduce((sum, s) => sum + s.costMicros, 0);
          const requiredMicros = committed[provider] + platformAllowance[provider];
          return {
            provider,
            committedMicros: committed[provider],
            platformAllowanceMicros: platformAllowance[provider],
            requiredMicros,
            spentThisMonthMicros: spentOf(),
            unfundedThisMonthMicros: spentOf(false),
            balanceMicros,
            shortfallMicros:
              balanceMicros === null ? null : Math.max(0, requiredMicros - balanceMicros),
          };
        }),
      );
    },

    async checkFunding() {
      const statuses = await service.fundingStatus();
      for (const status of statuses) {
        if (status.shortfallMicros === null || status.shortfallMicros === 0) continue;
        deps.logger.error(
          { ...status },
          "provider balance is below what customers have already paid for",
        );
        /* One email a day per provider; the lock is left to expire on its own. */
        const first = await deps.locks.acquire(`funding-alert:${status.provider}`, DAY_MS);
        if (first === null || deps.funding.opsEmail === undefined) continue;
        const to = deps.funding.opsEmail;
        await deps.db.transaction((tx) =>
          deps.outbox.emit(tx, "email.requested", {
            template: "ops-notice",
            to,
            data: {
              subject: `${status.provider} balance is ${usd(status.shortfallMicros ?? 0)} short`,
              heading: `Top up ${status.provider}`,
              lines: [
                `Customers have paid for ${usd(status.requiredMicros)} of ${status.provider} usage that hasn't been used yet.`,
                `The ${status.provider} balance is ${usd(status.balanceMicros ?? 0)}, which is ${usd(status.shortfallMicros ?? 0)} short.`,
                "Add funds, or raise the auto-recharge threshold to at least the amount customers have paid for.",
              ],
            },
            idempotencyKey: `funding:${status.provider}:${clock.now().toISOString().slice(0, 10)}`,
          }),
        );
      }
      return statuses;
    },
  };
  return service;
}
