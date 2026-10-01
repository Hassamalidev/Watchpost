/*
 * The effective plan of a workspace and the moment it changes (PRODUCT.md §11 "Entitlements").
 * `resolve` answers "what may this workspace do now" from the trial date and the live subscription.
 * `syncTx` compares that answer with the plan we last announced, emits billing.plan_changed when they
 * differ and stores when to look again (trial end, grace end, downgrade date), so the billing clock
 * sweep only visits workspaces whose plan can actually change.
 */
import type { Clock } from "../../core/clock.js";
import { createWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import type { PlanKey } from "@app/shared";
import {
  NO_ADDONS,
  TRIAL_PLAN,
  planRank,
  type AddonQuantities,
  type PriceCatalog,
} from "../../config/plans.js";
import type { DbOrTx, Tx } from "../../infra/db/index.js";
import type { Outbox } from "../../infra/outbox/index.js";
import type { WorkspacesService } from "../workspaces/index.js";
import type { BillingRepository } from "./billing.repository.js";
import { resolvePlan, type PlanResolution, type SubscriptionSnapshot } from "./entitlements.js";
import type { SubscriptionItem, SubscriptionRow } from "./schema/billing.js";

export interface PlanChange {
  from: PlanKey;
  to: PlanKey;
}

export interface PlanSync {
  addonsOf(items: SubscriptionItem[]): AddonQuantities;
  /* The plan the subscription itself grants right now (downgrade hold included); null if not live. */
  subscriptionPlan(row: SubscriptionRow, now: Date): PlanKey | null;
  resolve(
    db: DbOrTx,
    scope: WorkspaceScope,
  ): Promise<{ resolution: PlanResolution; subscription: SubscriptionRow | undefined }>;
  /* Announces a plan change if there is one. `force` re-announces the same plan (add-ons changed). */
  syncTx(tx: Tx, workspaceId: string, options?: { force?: boolean }): Promise<PlanChange | null>;
}

export function createPlanSync(deps: {
  repository: BillingRepository;
  workspaces: Pick<WorkspacesService, "getSettings">;
  outbox: Outbox;
  clock: Clock;
  catalog: PriceCatalog;
}): PlanSync {
  const { repository: repo, clock } = deps;

  function addonsOf(items: SubscriptionItem[]): AddonQuantities {
    const addons = { ...NO_ADDONS };
    for (const item of items) {
      const ref = deps.catalog.lookup(item.priceId);
      if (ref?.kind === "addon") addons[ref.addon] += Math.max(0, item.quantity);
    }
    return addons;
  }

  function snapshotOf(row: SubscriptionRow | undefined): SubscriptionSnapshot | null {
    if (row === undefined) return null;
    return {
      status: row.status,
      planKey: row.planKey,
      heldPlanKey: row.heldPlanKey,
      heldUntil: row.heldUntil,
      pastDueSince: row.pastDueSince,
      addons: addonsOf(row.items),
    };
  }

  async function trialEnd(scope: WorkspaceScope): Promise<Date | null> {
    const settings = await deps.workspaces.getSettings(scope);
    return settings.trialEndsAt === null ? null : new Date(settings.trialEndsAt);
  }

  return {
    addonsOf,

    subscriptionPlan(row, now) {
      if (row.status !== "active" && row.status !== "trialing") return null;
      if (
        row.heldPlanKey !== null &&
        row.heldUntil !== null &&
        now.getTime() < row.heldUntil.getTime() &&
        planRank(row.heldPlanKey) > planRank(row.planKey)
      ) {
        return row.heldPlanKey;
      }
      return row.planKey;
    },

    async resolve(db, scope) {
      const [trialEndsAt, subscription] = await Promise.all([
        trialEnd(scope),
        repo.liveSubscription(db, scope),
      ]);
      return {
        resolution: resolvePlan({
          now: clock.now(),
          trialEndsAt,
          subscription: snapshotOf(subscription),
        }),
        subscription,
      };
    },

    async syncTx(tx, workspaceId, options = {}) {
      const scope = createWorkspaceScope({ workspaceId });
      const trialEndsAt = await trialEnd(scope);
      /*
       * A workspace we never looked at starts from the trial plan if it ever had a trial, so a trial
       * that already ended is announced as a change and over-limit monitors get paused.
       */
      await repo.insertAccountIfMissing(tx, {
        workspaceId,
        effectivePlan: trialEndsAt === null ? "free" : TRIAL_PLAN,
      });
      const account = await repo.account(tx, workspaceId, true);
      if (account === undefined) throw new Error("billing account vanished inside a transaction");
      const resolution = resolvePlan({
        now: clock.now(),
        trialEndsAt,
        subscription: snapshotOf(await repo.liveSubscription(tx, scope)),
      });
      await repo.updateAccount(tx, workspaceId, {
        effectivePlan: resolution.plan,
        nextCheckAt: resolution.nextChangeAt,
      });
      if (account.effectivePlan === resolution.plan && options.force !== true) return null;
      const change = { from: account.effectivePlan, to: resolution.plan };
      await deps.outbox.emit(tx, "billing.plan_changed", change, { workspaceId });
      return change;
    },
  };
}
