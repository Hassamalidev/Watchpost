/*
 * Paddle Billing behind an adapter (PRODUCT.md §7.1 rule 12, §11). The SDK is imported only here;
 * modules see the small `PaddleApi` and `PaddleWebhooks` interfaces and plain data, so tests swap the
 * API for a fake and never talk to Paddle.
 *
 * Checked against developer.paddle.com on 2026-10-01:
 * - Webhooks are signed with `Paddle-Signature: ts=<unix>;h1=<hex hmac-sha256 of "ts:rawBody">`; the
 *   SDK rejects signatures more than 5 seconds old.
 * - `scheduled_change` only carries cancel, pause and resume. Paddle has no "change items at the next
 *   renewal", so a downgrade updates the items now with `do_not_bill` and the billing module keeps the
 *   old plan until the paid period ends.
 * - Customer portal links are short-lived and must not be stored.
 */
import { ApiError, Environment, Paddle, type Subscription } from "@paddle/paddle-node-sdk";
import { z } from "zod";
import { ProviderError } from "../../core/errors.js";

export const PADDLE_SIGNATURE_HEADER = "paddle-signature";

export const PADDLE_SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "paused",
  "canceled",
] as const;

export interface PaddleItem {
  priceId: string;
  quantity: number;
}

export interface PaddleSubscriptionData {
  id: string;
  status: (typeof PADDLE_SUBSCRIPTION_STATUSES)[number];
  customerId: string;
  items: PaddleItem[];
  periodStart: Date | null;
  periodEnd: Date | null;
  scheduledChange: {
    action: "cancel" | "pause" | "resume";
    effectiveAt: Date;
    resumeAt: Date | null;
  } | null;
  discountId: string | null;
  customData: Record<string, unknown> | null;
  canceledAt: Date | null;
  /* When Paddle last changed the subscription; orders reconcile results against webhooks. */
  updatedAt: Date;
}

export interface PaddleTransactionData {
  id: string;
  status: string;
  /* web (checkout), subscription_recurring (renewal), subscription_charge (one-time charge), … */
  origin: string;
  subscriptionId: string | null;
  customerId: string | null;
  items: PaddleItem[];
  customData: Record<string, unknown> | null;
  /* The subscription period this payment covers; null for one-time purchases. */
  billingPeriod: { startsAt: Date; endsAt: Date } | null;
}

export type PaddleWebhookEvent = {
  eventId: string;
  type: string;
  occurredAt: Date;
} & (
  | { kind: "subscription"; subscription: PaddleSubscriptionData }
  | { kind: "transaction"; transaction: PaddleTransactionData }
  | { kind: "other" }
);

export type ProrationMode = "prorated_immediately" | "do_not_bill";

export interface PaddleApi {
  getSubscription(id: string): Promise<PaddleSubscriptionData>;
  /* Replaces the subscription's items (send the complete list). */
  updateItems(
    id: string,
    items: PaddleItem[],
    mode: ProrationMode,
  ): Promise<PaddleSubscriptionData>;
  /* Cancels at the end of the period the customer already paid for. */
  cancelAtPeriodEnd(id: string): Promise<PaddleSubscriptionData>;
  /* Cancels right away (a paused subscription has no paid period left to run out). */
  cancelNow(id: string): Promise<PaddleSubscriptionData>;
  pauseAtPeriodEnd(id: string): Promise<PaddleSubscriptionData>;
  resumeNow(id: string): Promise<PaddleSubscriptionData>;
  /* Removes a scheduled cancel or pause. */
  clearScheduledChange(id: string): Promise<PaddleSubscriptionData>;
  /* Bills one-time items (credit packs) to the subscription's payment method right away. */
  chargeNow(id: string, items: PaddleItem[]): Promise<void>;
  /* A temporary link to Paddle's customer portal (payment method, invoices, cancellation). */
  portalUrl(customerId: string, subscriptionIds: string[]): Promise<string>;
}

export interface PaddleWebhooks {
  /* True only for a body signed with our secret within Paddle's replay window. */
  verify(rawBody: string, signature: string | undefined): Promise<boolean>;
}

const timestamp = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const item = z.object({ price: z.object({ id: z.string().min(1) }), quantity: z.number().int() });
const customData = z.record(z.string(), z.unknown()).nullish();

const subscriptionPayload = z.object({
  id: z.string().min(1),
  status: z.enum(PADDLE_SUBSCRIPTION_STATUSES),
  customer_id: z.string().min(1),
  items: z.array(item),
  current_billing_period: z.object({ starts_at: timestamp, ends_at: timestamp }).nullish(),
  scheduled_change: z
    .object({
      action: z.enum(["cancel", "pause", "resume"]),
      effective_at: timestamp,
      resume_at: timestamp.nullish(),
    })
    .nullish(),
  discount: z.object({ id: z.string() }).nullish(),
  custom_data: customData,
  canceled_at: timestamp.nullish(),
  updated_at: timestamp,
});

const transactionPayload = z.object({
  id: z.string().min(1),
  status: z.string(),
  origin: z.string().default("web"),
  subscription_id: z.string().nullish(),
  customer_id: z.string().nullish(),
  items: z.array(item).default([]),
  custom_data: customData,
  billing_period: z.object({ starts_at: timestamp, ends_at: timestamp }).nullish(),
});

const envelope = z.object({
  event_id: z.string().min(1).max(200),
  event_type: z.string().min(1).max(200),
  occurred_at: timestamp,
  data: z.unknown(),
});

function fromSubscriptionPayload(
  data: z.infer<typeof subscriptionPayload>,
): PaddleSubscriptionData {
  return {
    id: data.id,
    status: data.status,
    customerId: data.customer_id,
    items: data.items.map((i) => ({ priceId: i.price.id, quantity: i.quantity })),
    periodStart: data.current_billing_period?.starts_at ?? null,
    periodEnd: data.current_billing_period?.ends_at ?? null,
    scheduledChange: data.scheduled_change
      ? {
          action: data.scheduled_change.action,
          effectiveAt: data.scheduled_change.effective_at,
          resumeAt: data.scheduled_change.resume_at ?? null,
        }
      : null,
    discountId: data.discount?.id ?? null,
    customData: data.custom_data ?? null,
    canceledAt: data.canceled_at ?? null,
    updatedAt: data.updated_at,
  };
}

/* The envelope alone: enough to store an event before anyone looks at what is inside. */
export function parsePaddleEnvelope(
  payload: unknown,
): { eventId: string; type: string; occurredAt: Date } | undefined {
  const parsed = envelope.safeParse(payload);
  if (!parsed.success) return undefined;
  return {
    eventId: parsed.data.event_id,
    type: parsed.data.event_type,
    occurredAt: parsed.data.occurred_at,
  };
}

/*
 * Turns a verified webhook body (already JSON-parsed) into plain data. Throws a ZodError when the
 * envelope or a subscription/transaction payload doesn't look like Paddle's documented shape.
 */
export function parsePaddleWebhook(payload: unknown): PaddleWebhookEvent {
  const { event_id, event_type, occurred_at, data } = envelope.parse(payload);
  const base = { eventId: event_id, type: event_type, occurredAt: occurred_at };
  if (event_type.startsWith("subscription.")) {
    return {
      ...base,
      kind: "subscription",
      subscription: fromSubscriptionPayload(subscriptionPayload.parse(data)),
    };
  }
  if (event_type.startsWith("transaction.")) {
    const t = transactionPayload.parse(data);
    return {
      ...base,
      kind: "transaction",
      transaction: {
        id: t.id,
        status: t.status,
        origin: t.origin,
        subscriptionId: t.subscription_id ?? null,
        customerId: t.customer_id ?? null,
        items: t.items.map((i) => ({ priceId: i.price.id, quantity: i.quantity })),
        customData: t.custom_data ?? null,
        billingPeriod: t.billing_period
          ? { startsAt: t.billing_period.starts_at, endsAt: t.billing_period.ends_at }
          : null,
      },
    };
  }
  return { ...base, kind: "other" };
}

const toDate = (value: string | null | undefined): Date | null =>
  value === null || value === undefined ? null : new Date(value);

function fromSdkSubscription(sub: Subscription): PaddleSubscriptionData {
  return {
    id: sub.id,
    status: sub.status as PaddleSubscriptionData["status"],
    customerId: sub.customerId,
    items: sub.items.map((i) => ({ priceId: i.price.id, quantity: i.quantity })),
    periodStart: toDate(sub.currentBillingPeriod?.startsAt),
    periodEnd: toDate(sub.currentBillingPeriod?.endsAt),
    scheduledChange: sub.scheduledChange
      ? {
          action: sub.scheduledChange.action as "cancel" | "pause" | "resume",
          effectiveAt: new Date(sub.scheduledChange.effectiveAt),
          resumeAt: toDate(sub.scheduledChange.resumeAt),
        }
      : null,
    discountId: sub.discount?.id ?? null,
    customData: (sub.customData as Record<string, unknown> | null) ?? null,
    canceledAt: toDate(sub.canceledAt),
    updatedAt: new Date(sub.updatedAt),
  };
}

/* Paddle's own message is safe to show ("payment declined"); anything else stays generic. */
async function call<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const detail = err instanceof ApiError ? `${err.code}: ${err.detail}` : undefined;
    throw new ProviderError(
      "paddle",
      detail === undefined ? `Paddle could not ${what}.` : `Paddle could not ${what} (${detail}).`,
      { cause: err },
    );
  }
}

export interface PaddleClient {
  api: PaddleApi;
  webhooks: PaddleWebhooks;
}

export function createPaddle(options: {
  apiKey: string;
  webhookSecret: string;
  environment: "sandbox" | "production";
}): PaddleClient {
  const paddle = new Paddle(options.apiKey, {
    environment:
      options.environment === "production" ? Environment.production : Environment.sandbox,
  });
  const subs = paddle.subscriptions;

  return {
    webhooks: {
      async verify(rawBody, signature) {
        if (signature === undefined || signature === "") return false;
        try {
          return await paddle.webhooks.isSignatureValid(rawBody, options.webhookSecret, signature);
        } catch {
          /* The SDK throws on a header it can't parse. */
          return false;
        }
      },
    },
    api: {
      getSubscription: (id) =>
        call("load the subscription", async () => fromSdkSubscription(await subs.get(id))),
      updateItems: (id, items, mode) =>
        call("change the plan", async () =>
          fromSdkSubscription(await subs.update(id, { items, prorationBillingMode: mode })),
        ),
      cancelAtPeriodEnd: (id) =>
        call("cancel the subscription", async () =>
          fromSdkSubscription(await subs.cancel(id, { effectiveFrom: "next_billing_period" })),
        ),
      cancelNow: (id) =>
        call("cancel the subscription", async () =>
          fromSdkSubscription(await subs.cancel(id, { effectiveFrom: "immediately" })),
        ),
      pauseAtPeriodEnd: (id) =>
        call("pause the subscription", async () =>
          fromSdkSubscription(await subs.pause(id, { effectiveFrom: "next_billing_period" })),
        ),
      resumeNow: (id) =>
        call("resume the subscription", async () =>
          fromSdkSubscription(await subs.resume(id, { effectiveFrom: "immediately" })),
        ),
      clearScheduledChange: (id) =>
        call("keep the subscription", async () =>
          fromSdkSubscription(await subs.update(id, { scheduledChange: null })),
        ),
      chargeNow: (id, items) =>
        call("charge the payment method", async () => {
          await subs.createOneTimeCharge(id, { effectiveFrom: "immediately", items });
        }),
      portalUrl: (customerId, subscriptionIds) =>
        call("open the customer portal", async () => {
          const session = await paddle.customerPortalSessions.create(customerId, subscriptionIds);
          return session.urls.general.overview;
        }),
    },
  };
}
