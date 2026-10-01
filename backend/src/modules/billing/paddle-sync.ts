/*
 * Keeps our subscriptions in step with Paddle (PRODUCT.md §11 "Webhooks").
 *
 * A webhook is verified, stored in billing_events (unique event ID) and processed by a job, so a
 * redelivery or a retried job changes nothing. Subscription events carry the whole subscription, which
 * makes order irrelevant: an event older than the newest one applied is ignored (`last_event_at`).
 *
 * Money rule: credits and upstream funding follow collected payments, not status. A completed
 * transaction for a billing period is recorded in subscription_payments; billing.period_renewed is
 * emitted once per paid period, whichever of the payment and the subscription webhook arrives first.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { BillingInterval, PaidPlanKey, PlanKey } from "@app/shared";
import type { Clock } from "../../core/clock.js";
import { createWorkspaceScope } from "../../core/workspace-scope.js";
import {
  FOUNDING_CUSTOMER_SLOTS,
  PAST_DUE_GRACE_DAYS,
  PLANS,
  planRank,
  type PriceCatalog,
} from "../../config/plans.js";
import type { Db, Tx } from "../../infra/db/index.js";
import type { BillingEmailKind } from "../../infra/email/index.js";
import type { Logger } from "../../infra/logger.js";
import type { Outbox } from "../../infra/outbox/index.js";
import {
  parsePaddleEnvelope,
  parsePaddleWebhook,
  type PaddleApi,
  type PaddleSubscriptionData,
  type PaddleTransactionData,
  type PaddleWebhookEvent,
  type PaddleWebhooks,
} from "../../infra/paddle/index.js";
import type { WorkspacesService } from "../workspaces/index.js";
import type { BillingRepository } from "./billing.repository.js";
import type { PlanSync } from "./plan-sync.js";
import type { SubscriptionItem, SubscriptionRow } from "./schema/billing.js";

export type IngestOutcome =
  "accepted" | "duplicate" | "bad_signature" | "invalid" | "not_configured";

/* What processing an event did; stored on the event for the owner to read. */
export type EventOutcome =
  | "applied"
  | "stale"
  | "ignored"
  | "invalid"
  /* No workspace could be tied to the event (custom data missing or not signed by us). */
  | "unlinked"
  /* The subscription sells prices this server doesn't know (PADDLE_PRICE_* not set). */
  | "unknown_plan"
  /* The workspace already has another live subscription; someone must refund this one in Paddle. */
  | "conflict"
  | "missing";

export interface PaddleRuntime {
  api: PaddleApi;
  webhooks: PaddleWebhooks;
  environment: "sandbox" | "production";
  clientToken: string | undefined;
  foundingDiscountId: string | undefined;
}

export interface PaddleSync {
  /* Signature for the custom data our checkout hands to Paddle.js. */
  signCheckout(workspaceId: string, userId: string): string;
  ingest(rawBody: Buffer, signature: string | undefined): Promise<IngestOutcome>;
  process(eventId: string): Promise<EventOutcome>;
  /* Re-queues stored events nobody processed. Returns how many. */
  recover(): Promise<number>;
  /* Applies a subscription as Paddle's API returned it (after our own change, or the reconcile). */
  applyFromApi(data: PaddleSubscriptionData): Promise<EventOutcome>;
  /* Compares every live subscription with Paddle. */
  reconcile(): Promise<{ checked: number; failed: number }>;
  billingUrl(workspaceId: string): string;
  notify(
    tx: Tx,
    workspaceId: string,
    kind: BillingEmailKind,
    data: { planName?: string; date?: string; daysLeft?: number; credits?: number },
    key: string,
  ): Promise<void>;
}

const DAY_MS = 86_400_000;
const STALE_EVENT_MS = 60_000;
const RECOVERY_BATCH = 200;
/* An event that failed this often needs a person; the sweep stops re-queueing it. */
const MAX_EVENT_ATTEMPTS = 50;
const RETRY_BUCKET_MS = 10 * 60_000;
/* Who may attach a purchase to a workspace (the same roles the billing routes accept). */
const BILLING_MANAGER_ROLES: readonly string[] = ["owner", "admin", "billing"];

const checkoutData = z.object({
  workspaceId: z.uuid(),
  userId: z.string().min(1),
  sig: z.string(),
});

const longDate = (date: Date) =>
  new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: "UTC" }).format(date);

export function createPaddleSync(deps: {
  db: Db;
  repository: BillingRepository;
  planSync: PlanSync;
  workspaces: Pick<
    WorkspacesService,
    "exists" | "billingContacts" | "workspaceName" | "resolveRole"
  >;
  outbox: Outbox;
  clock: Clock;
  logger: Logger;
  newId: () => string;
  catalog: PriceCatalog;
  paddle: PaddleRuntime | undefined;
  authSecret: string;
  webOrigin: string;
  enqueue: (eventId: string, jobSuffix?: string) => Promise<void>;
}): PaddleSync {
  const { repository: repo, clock, logger, planSync } = deps;

  const signCheckout = (workspaceId: string, userId: string) =>
    createHmac("sha256", deps.authSecret)
      .update(`paddle-checkout:${workspaceId.toLowerCase()}:${userId}`)
      .digest("base64url");

  /*
   * The workspace a checkout was opened for. The custom data must carry our signature, the workspace
   * must exist, and the person who opened the checkout must still be allowed to manage its billing:
   * the signature doesn't expire, so someone removed from the workspace can't attach a purchase later.
   */
  async function linkedWorkspace(
    customData: Record<string, unknown> | null,
  ): Promise<string | undefined> {
    const parsed = checkoutData.safeParse(customData);
    if (!parsed.success) return undefined;
    const expected = Buffer.from(signCheckout(parsed.data.workspaceId, parsed.data.userId));
    const given = Buffer.from(parsed.data.sig);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    const workspaceId = parsed.data.workspaceId.toLowerCase();
    if (!(await deps.workspaces.exists(workspaceId))) return undefined;
    const role = await deps.workspaces.resolveRole(parsed.data.userId, workspaceId);
    return role !== undefined && BILLING_MANAGER_ROLES.includes(role) ? workspaceId : undefined;
  }

  const billingUrl = (workspaceId: string) => `${deps.webOrigin}/w/${workspaceId}/billing`;

  async function notify(
    tx: Tx,
    workspaceId: string,
    kind: BillingEmailKind,
    data: { planName?: string; date?: string; daysLeft?: number; credits?: number },
    key: string,
  ): Promise<void> {
    const scope = createWorkspaceScope({ workspaceId });
    const [contacts, workspaceName] = await Promise.all([
      deps.workspaces.billingContacts(scope),
      deps.workspaces.workspaceName(scope),
    ]);
    for (const contact of contacts) {
      await deps.outbox.emit(
        tx,
        "email.requested",
        {
          template: "billing",
          to: contact.email,
          data: { kind, workspaceName, url: billingUrl(workspaceId), ...data },
          idempotencyKey: `billing:${key}:${contact.userId}`.slice(0, 200),
        },
        { workspaceId },
      );
    }
  }

  function planOf(
    data: PaddleSubscriptionData,
  ): { plan: PaidPlanKey; interval: BillingInterval } | undefined {
    for (const item of data.items) {
      const ref = deps.catalog.lookup(item.priceId);
      if (ref?.kind === "plan") return { plan: ref.plan, interval: ref.interval };
    }
    return undefined;
  }

  /*
   * Emits billing.period_renewed for the newest paid period not announced yet. A payment that arrived
   * before the subscription has no period of its own; it takes the subscription's current one.
   */
  async function announcePaidPeriod(tx: Tx, row: SubscriptionRow): Promise<SubscriptionRow> {
    const payments = await repo.payments(tx, row.paddleSubscriptionId);
    let newest: { start: Date; end: Date } | undefined;
    for (const payment of payments) {
      let start = payment.periodStart;
      let end = payment.periodEnd;
      if (start === null || end === null) {
        if (row.periodStart === null || row.periodEnd === null) continue;
        start = row.periodStart;
        end = row.periodEnd;
        await repo.setPaymentPeriod(tx, payment.id, start, end);
      }
      if (newest === undefined || end.getTime() > newest.end.getTime()) newest = { start, end };
    }
    if (newest === undefined) return row;
    if (row.paidPeriodEnd !== null && newest.end.getTime() <= row.paidPeriodEnd.getTime()) {
      return row;
    }
    const updated = await repo.updateSubscription(tx, row.id, {
      paidPeriodStart: newest.start,
      paidPeriodEnd: newest.end,
    });
    await deps.outbox.emit(
      tx,
      "billing.period_renewed",
      { subscriptionId: row.id, periodEnd: newest.end.toISOString() },
      { workspaceId: row.workspaceId },
    );
    return updated;
  }

  async function applySubscription(
    tx: Tx,
    data: PaddleSubscriptionData,
    eventAt: Date,
    eventKey: string,
  ): Promise<EventOutcome> {
    await repo.lockPaddleSubscription(tx, data.id);
    const existing = await repo.subscriptionByPaddleId(tx, data.id, true);
    if (existing !== undefined && eventAt.getTime() < existing.lastEventAt.getTime()) {
      return "stale";
    }
    const sold = planOf(data);
    if (sold === undefined) {
      logger.error(
        { paddleSubscriptionId: data.id, priceIds: data.items.map((i) => i.priceId) },
        "Paddle subscription has no known plan price; check the PADDLE_PRICE_* variables",
      );
      return "unknown_plan";
    }

    const now = clock.now();
    let workspaceId = existing?.workspaceId;
    if (workspaceId === undefined) {
      workspaceId = await linkedWorkspace(data.customData);
      if (workspaceId === undefined) {
        logger.error(
          { paddleSubscriptionId: data.id },
          "Paddle subscription can't be tied to a workspace (custom data missing, not signed by us, or opened by someone who no longer manages billing there)",
        );
        return "unlinked";
      }
      /* Whatever its status: a second subscription never touches the workspace's billing record. */
      const live = await repo.liveSubscription(tx, createWorkspaceScope({ workspaceId }));
      if (live !== undefined) {
        logger.error(
          {
            workspaceId,
            paddleSubscriptionId: data.id,
            livePaddleSubscriptionId: live.paddleSubscriptionId,
          },
          "workspace already has a live subscription; cancel and refund the new one in Paddle",
        );
        return "conflict";
      }
    }

    /* A lower plan keeps the previous one until the period the customer paid for ends (§11). */
    let heldPlanKey: PlanKey | null = existing?.heldPlanKey ?? null;
    let heldUntil: Date | null = existing?.heldUntil ?? null;
    let heldItems: SubscriptionItem[] | null = existing?.heldItems ?? null;
    const before = existing === undefined ? null : planSync.subscriptionPlan(existing, now);
    if (data.status === "canceled") {
      heldPlanKey = null;
      heldUntil = null;
      heldItems = null;
    } else if (
      existing !== undefined &&
      before !== null &&
      planRank(sold.plan) < planRank(before) &&
      existing.periodEnd !== null &&
      existing.periodEnd.getTime() > now.getTime()
    ) {
      /* Read before the plan key changes: these are the items the paid period was bought with. */
      heldItems = planSync.effectiveItems(existing, now);
      heldPlanKey = before;
      heldUntil = existing.periodEnd;
    } else if (heldPlanKey !== null && planRank(sold.plan) >= planRank(heldPlanKey)) {
      heldPlanKey = null;
      heldUntil = null;
      heldItems = null;
    }

    const items = data.items.map((i) => ({ priceId: i.priceId, quantity: i.quantity }));
    const values = {
      paddleCustomerId: data.customerId,
      status: data.status,
      planKey: sold.plan,
      billingInterval: sold.interval,
      items,
      periodStart: data.periodStart,
      periodEnd: data.periodEnd,
      scheduledChange:
        data.scheduledChange === null
          ? null
          : {
              action: data.scheduledChange.action,
              effectiveAt: data.scheduledChange.effectiveAt.toISOString(),
              resumeAt: data.scheduledChange.resumeAt?.toISOString() ?? null,
            },
      pastDueSince: data.status === "past_due" ? (existing?.pastDueSince ?? eventAt) : null,
      heldPlanKey,
      heldUntil,
      heldItems,
      discountId: data.discountId,
      canceledAt: data.status === "canceled" ? (data.canceledAt ?? eventAt) : null,
      lastEventAt: eventAt,
    };
    const saved =
      existing === undefined
        ? await repo.insertSubscription(tx, {
            id: deps.newId(),
            workspaceId,
            paddleSubscriptionId: data.id,
            ...values,
          })
        : await repo.updateSubscription(tx, existing.id, values);
    const row = data.status === "active" ? await announcePaidPeriod(tx, saved) : saved;

    const addonsNow = (r: SubscriptionRow) =>
      JSON.stringify(planSync.addonsOf(planSync.effectiveItems(r, now)));
    const addonsChanged = existing !== undefined && addonsNow(existing) !== addonsNow(saved);
    await planSync.syncTx(tx, workspaceId, { force: addonsChanged });
    await repo.updateAccount(tx, workspaceId, { paddleCustomerId: data.customerId });
    if (
      data.status === "active" &&
      deps.paddle?.foundingDiscountId !== undefined &&
      data.discountId === deps.paddle.foundingDiscountId
    ) {
      await repo.claimFoundingNumber(tx, workspaceId, FOUNDING_CUSTOMER_SLOTS);
    }

    const wasLive = existing?.status === "active" || existing?.status === "trialing";
    if (data.status === "active" && !wasLive && existing?.status !== "past_due") {
      await notify(
        tx,
        workspaceId,
        "subscription_started",
        {
          planName: PLANS[sold.plan].name,
          ...(row.periodEnd === null ? {} : { date: longDate(row.periodEnd) }),
        },
        `started:${row.id}:${eventKey}`,
      );
    }
    if (data.status === "canceled" && existing !== undefined && existing.status !== "canceled") {
      await notify(tx, workspaceId, "subscription_canceled", {}, `canceled:${row.id}`);
    }
    return "applied";
  }

  /*
   * A payment for a billing period: the first checkout, a renewal, or a subscription update that
   * starts a new period (monthly to yearly). A proration inside the current period ends where the
   * paid period already ends, so it announces nothing; one-time charges carry no plan item.
   */
  const isPeriodPayment = (t: PaddleTransactionData) =>
    t.subscriptionId !== null &&
    t.items.some((i) => deps.catalog.lookup(i.priceId)?.kind === "plan") &&
    (["web", "api", "subscription_recurring"].includes(t.origin) ||
      (t.origin === "subscription_update" && t.billingPeriod !== null));

  async function applyTransaction(
    tx: Tx,
    event: Extract<PaddleWebhookEvent, { kind: "transaction" }>,
  ): Promise<EventOutcome> {
    const t = event.transaction;
    const row =
      t.subscriptionId === null
        ? undefined
        : (await repo.lockPaddleSubscription(tx, t.subscriptionId),
          await repo.subscriptionByPaddleId(tx, t.subscriptionId, true));

    if (event.type === "transaction.payment_failed") {
      if (row === undefined || !t.origin.startsWith("subscription")) return "ignored";
      const since = row.pastDueSince ?? event.occurredAt;
      await notify(
        tx,
        row.workspaceId,
        "payment_failed",
        {
          planName: PLANS[row.planKey].name,
          date: longDate(new Date(since.getTime() + PAST_DUE_GRACE_DAYS * DAY_MS)),
        },
        `payment-failed:${event.eventId}`,
      );
      return "applied";
    }
    if (event.type !== "transaction.completed") return "ignored";

    let outcome: EventOutcome = "ignored";
    if (t.subscriptionId !== null && isPeriodPayment(t)) {
      /* Recorded even when the subscription webhook hasn't arrived; it announces the period later. */
      await repo.insertPayment(tx, {
        id: deps.newId(),
        paddleSubscriptionId: t.subscriptionId,
        transactionId: t.id,
        periodStart: t.billingPeriod?.startsAt ?? null,
        periodEnd: t.billingPeriod?.endsAt ?? null,
      });
      if (row !== undefined && row.status === "active") await announcePaidPeriod(tx, row);
      outcome = "applied";
    }

    let credits = 0;
    for (const item of t.items) {
      const ref = deps.catalog.lookup(item.priceId);
      if (ref?.kind === "credits") credits += ref.credits * Math.max(0, item.quantity);
    }
    if (credits > 0) {
      const workspaceId = row?.workspaceId ?? (await linkedWorkspace(t.customData));
      if (workspaceId === undefined) {
        logger.error(
          { transactionId: t.id, credits },
          "paid credit pack can't be tied to a workspace; refund it in Paddle or grant it by hand",
        );
        return "unlinked";
      }
      await deps.outbox.emit(
        tx,
        "billing.credits_purchased",
        { transactionId: t.id, credits },
        { workspaceId },
      );
      outcome = "applied";
    }
    return outcome;
  }

  async function apply(tx: Tx, event: PaddleWebhookEvent): Promise<EventOutcome> {
    if (event.kind === "subscription") {
      /*
       * Ordered by the subscription's own `updated_at`, the same clock API answers carry, so a webhook
       * and an API result for nearby changes can't be misjudged against each other.
       */
      return applySubscription(tx, event.subscription, event.subscription.updatedAt, event.eventId);
    }
    if (event.kind === "transaction") return applyTransaction(tx, event);
    return "ignored";
  }

  return {
    signCheckout,
    billingUrl,
    notify,

    async ingest(rawBody, signature) {
      if (deps.paddle === undefined) return "not_configured";
      const text = rawBody.toString("utf8");
      if (!(await deps.paddle.webhooks.verify(text, signature))) return "bad_signature";
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        return "invalid";
      }
      const head = parsePaddleEnvelope(payload);
      if (head === undefined) return "invalid";
      const inserted = await repo.insertEvent(deps.db, {
        id: deps.newId(),
        eventId: head.eventId,
        type: head.type,
        occurredAt: head.occurredAt,
        payload,
      });
      if (!inserted) return "duplicate";
      /* The event is safe in Postgres; if Redis is down the recovery sweep queues it later. */
      await deps.enqueue(head.eventId).catch((err: unknown) => {
        logger.warn({ err, eventId: head.eventId }, "could not queue Paddle event; sweep will");
      });
      return "accepted";
    },

    async process(eventId) {
      try {
        return await deps.db.transaction(async (tx) => {
          const row = await repo.eventForUpdate(tx, eventId);
          if (row === undefined) return "missing";
          if (row.processedAt !== null) return (row.outcome as EventOutcome | null) ?? "applied";
          let event: PaddleWebhookEvent | undefined;
          try {
            event = parsePaddleWebhook(row.payload);
          } catch (err) {
            logger.error({ err, eventId }, "Paddle event doesn't match the documented shape");
          }
          const outcome: EventOutcome = event === undefined ? "invalid" : await apply(tx, event);
          await repo.markEventProcessed(tx, row.id, outcome, clock.now());
          return outcome;
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await repo.recordEventFailure(deps.db, eventId, message).catch(() => {});
        throw err;
      }
    },

    async recover() {
      const stale = await repo.unprocessedEvents(
        deps.db,
        new Date(clock.now().getTime() - STALE_EVENT_MS),
        MAX_EVENT_ATTEMPTS,
        RECOVERY_BATCH,
      );
      /*
       * A fresh job ID per failed attempt and per time bucket: a queued job isn't duplicated, a failed
       * one retries, and a failure that was never recorded (Postgres down) can't pin the same ID forever.
       */
      const bucket = Math.floor(clock.now().getTime() / RETRY_BUCKET_MS);
      for (const event of stale) {
        await deps.enqueue(event.eventId, `r${event.attempts}t${bucket}`);
      }
      return stale.length;
    },

    async applyFromApi(data) {
      return deps.db.transaction((tx) =>
        applySubscription(tx, data, data.updatedAt, `api:${data.updatedAt.getTime()}`),
      );
    },

    async reconcile() {
      if (deps.paddle === undefined) return { checked: 0, failed: 0 };
      let checked = 0;
      let failed = 0;
      let afterId: string | undefined;
      for (;;) {
        const rows = await repo.liveSubscriptions(deps.db, { afterId, limit: 100 });
        for (const row of rows) {
          checked += 1;
          try {
            const data = await deps.paddle.api.getSubscription(row.paddleSubscriptionId);
            await deps.db.transaction((tx) =>
              applySubscription(tx, data, data.updatedAt, `reconcile:${data.updatedAt.getTime()}`),
            );
          } catch (err) {
            failed += 1;
            logger.warn(
              { err, paddleSubscriptionId: row.paddleSubscriptionId },
              "could not reconcile a subscription with Paddle",
            );
          }
        }
        if (rows.length < 100) return { checked, failed };
        afterId = rows.at(-1)?.id;
      }
    },
  };
}
