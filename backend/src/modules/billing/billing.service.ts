/*
 * Billing rules (PRODUCT.md §5, §11): what a workspace may do (entitlements), what the billing page
 * shows, and the actions a customer takes there (checkout, plan change, credit packs, cancel, pause,
 * resume, portal). Paddle is the source of truth for money; every action calls Paddle first and then
 * applies Paddle's answer through the same code path the webhooks use.
 */
import type {
  BillingInterval,
  BillingState,
  CancelReason,
  CheckoutSession,
  CreditPack,
  Entitlements,
  PaidPlanKey,
  PlanFeature,
  PlanKey,
  PlanLimits,
  SubscriptionView,
} from "@app/shared";
import { CREDIT_PACKS, PLAN_KEYS } from "@app/shared";
import type { Clock } from "../../core/clock.js";
import { AppError, ConflictError, NotFoundError } from "../../core/errors.js";
import type { SessionContext } from "../../core/session.js";
import { createWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import {
  CREDIT_PACK_USD,
  FOUNDING_CUSTOMER_SLOTS,
  PLANS,
  planRank,
  type AddonKey,
  type PriceCatalog,
} from "../../config/plans.js";
import type { Db } from "../../infra/db/index.js";
import type { Locks } from "../../infra/locks.js";
import type { Logger } from "../../infra/logger.js";
import type { PaddleItem } from "../../infra/paddle/index.js";
import type { WorkspacesService } from "../workspaces/index.js";
import type { BillingRepository } from "./billing.repository.js";
import { toEntitlements } from "./entitlements.js";
import type { PaddleRuntime, PaddleSync } from "./paddle-sync.js";
import type { PlanChange, PlanSync } from "./plan-sync.js";
import type { SubscriptionRow } from "./schema/billing.js";

/* A subscription with a collected payment covering now; what credits and funding are granted for. */
export interface PaidSubscription {
  id: string;
  workspaceId: string;
  /* The plan the subscription grants now (the held plan after a downgrade included). */
  plan: PaidPlanKey;
  paidPeriodStart: Date;
  paidPeriodEnd: Date;
}

export interface BillingService {
  entitlements(scope: WorkspaceScope): Promise<Entitlements>;
  limits(scope: WorkspaceScope): Promise<PlanLimits>;
  hasFeature(scope: WorkspaceScope, feature: PlanFeature): Promise<boolean>;
  /* For Better Auth's membership limit (it wants a number). */
  memberLimit(workspaceId: string): Promise<number>;
  state(scope: WorkspaceScope): Promise<BillingState>;
  checkout(
    scope: WorkspaceScope,
    session: SessionContext,
    input: { plan: PaidPlanKey; interval: BillingInterval },
  ): Promise<CheckoutSession>;
  changePlan(
    scope: WorkspaceScope,
    input: { plan: PaidPlanKey; interval: BillingInterval },
  ): Promise<BillingState>;
  /* Charges the subscription's payment method; credits arrive with Paddle's webhook. */
  buyCredits(scope: WorkspaceScope, credits: CreditPack): Promise<void>;
  cancel(
    scope: WorkspaceScope,
    input: { reason: CancelReason; comment?: string | undefined },
  ): Promise<BillingState>;
  pause(scope: WorkspaceScope): Promise<BillingState>;
  /* Undoes a scheduled cancel or pause, or resumes a paused subscription. */
  resume(scope: WorkspaceScope): Promise<BillingState>;
  portal(scope: WorkspaceScope): Promise<{ url: string }>;

  /* The workspace's paid subscription, if a collected payment covers now. */
  paidSubscription(scope: WorkspaceScope): Promise<PaidSubscription | null>;
  /* System: every paid subscription, paged by ID (monthly credit grants). */
  paidSubscriptions(options: {
    afterId?: string | undefined;
    limit: number;
  }): Promise<{ subscriptions: PaidSubscription[]; nextAfterId: string | null }>;

  /* System: creates the billing account of a workspace and announces its plan. Idempotent. */
  ensureAccount(workspaceId: string): Promise<PlanChange | null>;
  /* System: re-checks workspaces whose plan may have changed on its own. Returns how many changed. */
  runClock(limit?: number): Promise<number>;
  /* System: accounts for workspaces created before billing existed. Returns how many were created. */
  backfillAccounts(): Promise<number>;
}

const UNLIMITED_MEMBERS = 100_000;
const CLOCK_BATCH = 200;
const BACKFILL_PAGE = 500;
const CHARGE_LOCK_MS = 20_000;

/* Add-ons a plan may carry (§5); others are dropped when the plan changes. */
const ADDON_PLANS: Record<AddonKey, readonly PlanKey[]> = {
  extraMonitors100: ["pro", "business"],
  extraProbe: ["pro", "business"],
  extraClientWorkspace: ["business"],
};

const unavailable = (message: string) => new AppError(503, "service_unavailable", message);

export function createBillingService(deps: {
  db: Db;
  repository: BillingRepository;
  planSync: PlanSync;
  paddleSync: PaddleSync;
  workspaces: Pick<WorkspacesService, "countMembers" | "workspaceIds">;
  clock: Clock;
  logger: Logger;
  locks: Pick<Locks, "withLock">;
  catalog: PriceCatalog;
  paddle: PaddleRuntime | undefined;
}): BillingService {
  const { repository: repo, planSync, paddleSync, clock, catalog } = deps;
  const system = (workspaceId: string) => createWorkspaceScope({ workspaceId });

  function requirePaddle(): PaddleRuntime {
    if (deps.paddle === undefined) {
      throw unavailable("Billing isn't set up on this server yet.");
    }
    return deps.paddle;
  }

  async function liveOrThrow(scope: WorkspaceScope): Promise<SubscriptionRow> {
    const live = await repo.liveSubscription(deps.db, scope);
    if (live === undefined) throw new NotFoundError("This workspace has no subscription.");
    return live;
  }

  function toPaid(row: SubscriptionRow, now: Date): PaidSubscription | null {
    if (row.status !== "active" || row.paidPeriodStart === null || row.paidPeriodEnd === null) {
      return null;
    }
    if (now.getTime() >= row.paidPeriodEnd.getTime()) return null;
    const plan = planSync.subscriptionPlan(row, now);
    if (plan === null || plan === "free") return null;
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      plan,
      paidPeriodStart: row.paidPeriodStart,
      paidPeriodEnd: row.paidPeriodEnd,
    };
  }

  function toView(row: SubscriptionRow | undefined, now: Date): SubscriptionView | null {
    if (row === undefined) return null;
    const held =
      row.heldPlanKey !== null &&
      row.heldUntil !== null &&
      row.heldUntil.getTime() > now.getTime() &&
      planRank(row.heldPlanKey) > planRank(row.planKey);
    return {
      status: row.status,
      plan: row.planKey,
      interval: row.billingInterval,
      currentPeriodEnd: row.periodEnd?.toISOString() ?? null,
      scheduledChange:
        row.scheduledChange === null
          ? null
          : { action: row.scheduledChange.action, effectiveAt: row.scheduledChange.effectiveAt },
      downgrade:
        held && row.heldPlanKey !== null && row.heldUntil !== null
          ? { from: row.heldPlanKey, effectiveAt: row.heldUntil.toISOString() }
          : null,
    };
  }

  const checkoutReady = () => deps.paddle?.clientToken !== undefined;

  const service: BillingService = {
    async entitlements(scope) {
      return toEntitlements((await planSync.resolve(deps.db, scope)).resolution);
    },

    async limits(scope) {
      return (await service.entitlements(scope)).limits;
    },

    async hasFeature(scope, feature) {
      return (await service.entitlements(scope)).features[feature];
    },

    async memberLimit(workspaceId) {
      const { members } = await service.limits(system(workspaceId));
      return members === "unlimited" ? UNLIMITED_MEMBERS : members;
    },

    async state(scope) {
      const [{ resolution, subscription }, members, account, founders] = await Promise.all([
        planSync.resolve(deps.db, scope),
        deps.workspaces.countMembers(scope),
        repo.account(deps.db, scope.workspaceId),
        repo.foundingCount(deps.db),
      ]);
      const entitlements = toEntitlements(resolution);
      const isFoundingCustomer = account?.foundingNumber != null;
      return {
        entitlements,
        subscription: toView(subscription, clock.now()),
        usage: { members: { used: members, limit: entitlements.limits.members } },
        catalog: {
          plans: PLAN_KEYS.map((key) => ({
            key,
            name: PLANS[key].name,
            limits: PLANS[key].limits,
            features: PLANS[key].features,
            monthlyUsd: PLANS[key].monthlyUsd,
            annualMonthlyUsd: PLANS[key].annualMonthlyUsd,
            purchasable: {
              month:
                key !== "free" && checkoutReady() && catalog.planPrice(key, "month") !== undefined,
              year:
                key !== "free" && checkoutReady() && catalog.planPrice(key, "year") !== undefined,
            },
          })),
          creditPacks: CREDIT_PACKS.map((credits) => ({
            credits,
            usd: CREDIT_PACK_USD[credits],
            purchasable: deps.paddle !== undefined && catalog.creditPrice(credits) !== undefined,
          })),
        },
        paddle:
          deps.paddle?.clientToken === undefined
            ? null
            : { environment: deps.paddle.environment, clientToken: deps.paddle.clientToken },
        foundingOfferAvailable:
          deps.paddle?.foundingDiscountId !== undefined &&
          !isFoundingCustomer &&
          subscription === undefined &&
          founders < FOUNDING_CUSTOMER_SLOTS,
        isFoundingCustomer,
      };
    },

    async checkout(scope, session, input) {
      const paddle = requirePaddle();
      const priceId = catalog.planPrice(input.plan, input.interval);
      if (priceId === undefined || paddle.clientToken === undefined) {
        throw unavailable("This plan can't be bought on this server yet.");
      }
      if ((await repo.liveSubscription(deps.db, scope)) !== undefined) {
        throw new ConflictError(
          "This workspace already has a subscription. Change the plan instead.",
        );
      }
      const [account, founders] = await Promise.all([
        repo.account(deps.db, scope.workspaceId),
        repo.foundingCount(deps.db),
      ]);
      const founding =
        paddle.foundingDiscountId !== undefined &&
        account?.foundingNumber == null &&
        founders < FOUNDING_CUSTOMER_SLOTS;
      return {
        items: [{ priceId, quantity: 1 }],
        customerEmail: session.email,
        customData: {
          workspaceId: scope.workspaceId,
          userId: session.userId,
          sig: paddleSync.signCheckout(scope.workspaceId, session.userId),
        },
        discountId: founding ? (paddle.foundingDiscountId ?? null) : null,
      };
    },

    async changePlan(scope, input) {
      const paddle = requirePaddle();
      const live = await liveOrThrow(scope);
      if (live.status === "past_due") {
        throw new ConflictError("A payment is overdue. Update the payment method first.");
      }
      if (live.status !== "active") {
        throw new ConflictError("The subscription isn't active. Resume it before changing plans.");
      }
      if (live.scheduledChange !== null) {
        throw new ConflictError(
          `The subscription is set to ${live.scheduledChange.action}. Keep the subscription first, then change the plan.`,
        );
      }
      if (input.plan === live.planKey && input.interval === live.billingInterval) {
        throw new ConflictError("The workspace is already on this plan.");
      }
      if (live.billingInterval === "year" && input.interval === "month") {
        throw new ConflictError(
          "An annual subscription can move to monthly billing at renewal. Open the customer portal or contact support.",
        );
      }
      const higher = planRank(input.plan) > planRank(live.planKey);
      const sameLonger = input.plan === live.planKey && input.interval === "year";
      const upgrade = higher || sameLonger;
      if (!upgrade && input.interval !== live.billingInterval) {
        throw new ConflictError("Keep the same billing interval when moving to a smaller plan.");
      }
      const priceId = catalog.planPrice(input.plan, input.interval);
      if (priceId === undefined) throw unavailable("This plan can't be bought on this server yet.");

      const items: PaddleItem[] = [{ priceId, quantity: 1 }];
      for (const item of live.items) {
        const ref = catalog.lookup(item.priceId);
        if (ref?.kind === "addon" && ADDON_PLANS[ref.addon].includes(input.plan)) items.push(item);
      }
      /*
       * Upgrades bill the difference now. Downgrades change the items without billing; the next
       * renewal charges the smaller price and the old plan is held until then (paddle-sync).
       */
      const data = await paddle.api.updateItems(
        live.paddleSubscriptionId,
        items,
        upgrade ? "prorated_immediately" : "do_not_bill",
      );
      await paddleSync.applyFromApi(data);
      return service.state(scope);
    },

    async buyCredits(scope, credits) {
      const paddle = requirePaddle();
      const priceId = catalog.creditPrice(credits);
      if (priceId === undefined) throw unavailable("Credit packs can't be bought here yet.");
      const live = await repo.liveSubscription(deps.db, scope);
      if (live === undefined || live.status !== "active") {
        throw new ConflictError("Credit packs need an active Starter, Pro or Business plan.");
      }
      /* One purchase at a time per workspace, so a double click can't charge twice. */
      const result = await deps.locks.withLock(
        `billing-charge:${scope.workspaceId}`,
        CHARGE_LOCK_MS,
        () => paddle.api.chargeNow(live.paddleSubscriptionId, [{ priceId, quantity: 1 }]),
      );
      if (!result.acquired) {
        throw new ConflictError("A purchase is already in progress. Try again in a moment.");
      }
    },

    async cancel(scope, input) {
      const paddle = requirePaddle();
      const live = await liveOrThrow(scope);
      if (live.scheduledChange?.action === "cancel") {
        throw new ConflictError("The subscription is already set to cancel.");
      }
      if (live.scheduledChange !== null) {
        await paddle.api.clearScheduledChange(live.paddleSubscriptionId);
      }
      const data = await paddle.api.cancelAtPeriodEnd(live.paddleSubscriptionId);
      await paddleSync.applyFromApi(data);
      await repo.updateSubscription(deps.db, live.id, {
        cancelReason: input.reason,
        cancelComment: input.comment?.slice(0, 1_000) ?? null,
      });
      deps.logger.info(
        { workspaceId: scope.workspaceId, reason: input.reason },
        "subscription set to cancel",
      );
      return service.state(scope);
    },

    async pause(scope) {
      const paddle = requirePaddle();
      const live = await liveOrThrow(scope);
      if (live.status !== "active") {
        throw new ConflictError("Only an active subscription can be paused.");
      }
      if (live.scheduledChange !== null) {
        throw new ConflictError(
          `The subscription is already set to ${live.scheduledChange.action}.`,
        );
      }
      await paddleSync.applyFromApi(await paddle.api.pauseAtPeriodEnd(live.paddleSubscriptionId));
      return service.state(scope);
    },

    async resume(scope) {
      const paddle = requirePaddle();
      const live = await liveOrThrow(scope);
      if (live.scheduledChange !== null && live.scheduledChange.action !== "resume") {
        const data = await paddle.api.clearScheduledChange(live.paddleSubscriptionId);
        await paddleSync.applyFromApi(data);
        await repo.updateSubscription(deps.db, live.id, {
          cancelReason: null,
          cancelComment: null,
        });
      } else if (live.status === "paused") {
        await paddleSync.applyFromApi(await paddle.api.resumeNow(live.paddleSubscriptionId));
      } else {
        throw new ConflictError("There is nothing to resume: the subscription is running.");
      }
      return service.state(scope);
    },

    async portal(scope) {
      const paddle = requirePaddle();
      const [account, live] = await Promise.all([
        repo.account(deps.db, scope.workspaceId),
        repo.liveSubscription(deps.db, scope),
      ]);
      if (account?.paddleCustomerId == null) {
        throw new NotFoundError("There are no invoices yet: this workspace has never subscribed.");
      }
      const url = await paddle.api.portalUrl(
        account.paddleCustomerId,
        live === undefined ? [] : [live.paddleSubscriptionId],
      );
      return { url };
    },

    async paidSubscription(scope) {
      const live = await repo.liveSubscription(deps.db, scope);
      return live === undefined ? null : toPaid(live, clock.now());
    },

    async paidSubscriptions({ afterId, limit }) {
      const rows = await repo.liveSubscriptions(deps.db, { afterId, limit });
      const now = clock.now();
      return {
        subscriptions: rows.flatMap((row) => {
          const paid = toPaid(row, now);
          return paid === null ? [] : [paid];
        }),
        nextAfterId: rows.length === limit ? (rows.at(-1)?.id ?? null) : null,
      };
    },

    async ensureAccount(workspaceId) {
      return deps.db.transaction((tx) => planSync.syncTx(tx, workspaceId));
    },

    async runClock(limit = CLOCK_BATCH) {
      const due = await repo.dueAccounts(deps.db, clock.now(), limit);
      let changed = 0;
      for (const workspaceId of due) {
        try {
          if ((await service.ensureAccount(workspaceId)) !== null) changed += 1;
        } catch (err) {
          deps.logger.warn({ err, workspaceId }, "could not re-check a workspace's plan");
        }
      }
      return changed;
    },

    async backfillAccounts() {
      let created = 0;
      let afterId: string | undefined;
      for (;;) {
        const ids = await deps.workspaces.workspaceIds({
          limit: BACKFILL_PAGE,
          ...(afterId === undefined ? {} : { afterId }),
        });
        const known = await repo.existingAccounts(deps.db, ids);
        for (const id of ids) {
          if (known.has(id)) continue;
          await service.ensureAccount(id);
          created += 1;
        }
        if (ids.length < BACKFILL_PAGE) return created;
        afterId = ids.at(-1);
      }
    },
  };
  return service;
}
