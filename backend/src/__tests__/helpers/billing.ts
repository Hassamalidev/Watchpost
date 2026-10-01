/*
 * Billing test kit: Paddle switched on with test keys, a fake Paddle API that keeps subscriptions in
 * memory, and webhooks signed exactly like Paddle signs them (the real SDK verifies them).
 */
import { createHmac, randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { expect } from "vitest";
import type { Clock } from "../../core/clock.js";
import { outboxEvents } from "../../infra/outbox/index.js";
import type {
  PaddleApi,
  PaddleItem,
  PaddleSubscriptionData,
  ProrationMode,
} from "../../infra/paddle/index.js";
import type { BillingModule } from "../../modules/billing/index.js";
import type { MonitorsModule } from "../../modules/monitors/index.js";
import type { WorkspacesModule } from "../../modules/workspaces/index.js";
import { WEB_ORIGIN, buildContainerApp, signUpVerified } from "./container-app.js";

export const PADDLE_WEBHOOK_SECRET = "pdl_ntfset_test_secret_0123456789";

export const PRICES = {
  starterMonth: "pri_startermonth",
  starterYear: "pri_starteryear",
  proMonth: "pri_promonth",
  proYear: "pri_proyear",
  businessMonth: "pri_businessmonth",
  credits100: "pri_credits100",
  credits500: "pri_credits500",
  extraMonitors: "pri_extramonitors",
} as const;

/* Business annual is left out on purpose: tests use it as "not sold on this server". */
export const PADDLE_ENV: Record<string, string> = {
  PADDLE_ENV: "sandbox",
  PADDLE_API_KEY: "pdl_sdbx_apikey_test_0123456789",
  PADDLE_WEBHOOK_SECRET,
  NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "test_client_token_0123456789",
  PADDLE_DISCOUNT_FOUNDING: "dsc_founding30",
  PADDLE_PRICE_STARTER_MONTHLY: PRICES.starterMonth,
  PADDLE_PRICE_STARTER_ANNUAL: PRICES.starterYear,
  PADDLE_PRICE_PRO_MONTHLY: PRICES.proMonth,
  PADDLE_PRICE_PRO_ANNUAL: PRICES.proYear,
  PADDLE_PRICE_BUSINESS_MONTHLY: PRICES.businessMonth,
  PADDLE_PRICE_CREDITS_100: PRICES.credits100,
  PADDLE_PRICE_CREDITS_500: PRICES.credits500,
  PADDLE_PRICE_EXTRA_MONITORS_100: PRICES.extraMonitors,
};

export type FakePaddleCall =
  | { method: "updateItems"; id: string; items: PaddleItem[]; mode: ProrationMode }
  | { method: "chargeNow"; id: string; items: PaddleItem[] }
  | {
      method: "cancelAtPeriodEnd" | "pauseAtPeriodEnd" | "resumeNow" | "clearScheduledChange";
      id: string;
    }
  | { method: "portalUrl"; id: string; subscriptionIds: string[] };

/* Paddle's API in memory. Every change bumps `updatedAt`, like Paddle does. */
export function fakePaddleApi(clock: Clock) {
  const subscriptions = new Map<string, PaddleSubscriptionData>();
  const calls: FakePaddleCall[] = [];
  let failNext: Error | undefined;

  const must = (id: string) => {
    if (failNext !== undefined) {
      const err = failNext;
      failNext = undefined;
      throw err;
    }
    const sub = subscriptions.get(id);
    if (sub === undefined) throw new Error(`fake Paddle has no subscription ${id}`);
    return sub;
  };
  const touch = (sub: PaddleSubscriptionData, patch: Partial<PaddleSubscriptionData>) => {
    /* Paddle's clock never runs backwards for one subscription. */
    const updatedAt = new Date(Math.max(clock.now().getTime(), sub.updatedAt.getTime() + 1));
    Object.assign(sub, patch, { updatedAt });
    return structuredClone(sub);
  };
  const periodEnd = (sub: PaddleSubscriptionData) => sub.periodEnd ?? clock.now();

  const api: PaddleApi = {
    getSubscription: async (id) => structuredClone(must(id)),
    async updateItems(id, items, mode) {
      const sub = must(id);
      calls.push({ method: "updateItems", id, items, mode });
      return touch(sub, { items });
    },
    async cancelAtPeriodEnd(id) {
      const sub = must(id);
      calls.push({ method: "cancelAtPeriodEnd", id });
      return touch(sub, {
        scheduledChange: { action: "cancel", effectiveAt: periodEnd(sub), resumeAt: null },
      });
    },
    async pauseAtPeriodEnd(id) {
      const sub = must(id);
      calls.push({ method: "pauseAtPeriodEnd", id });
      return touch(sub, {
        scheduledChange: { action: "pause", effectiveAt: periodEnd(sub), resumeAt: null },
      });
    },
    async resumeNow(id) {
      const sub = must(id);
      calls.push({ method: "resumeNow", id });
      return touch(sub, { status: "active", scheduledChange: null });
    },
    async clearScheduledChange(id) {
      const sub = must(id);
      calls.push({ method: "clearScheduledChange", id });
      return touch(sub, { scheduledChange: null });
    },
    async chargeNow(id, items) {
      must(id);
      calls.push({ method: "chargeNow", id, items });
    },
    async portalUrl(customerId, subscriptionIds) {
      calls.push({ method: "portalUrl", id: customerId, subscriptionIds });
      return `https://sandbox-customer-portal.paddle.com/cpl_test?token=${customerId}`;
    },
  };

  return {
    api,
    calls,
    subscriptions,
    /* Makes the fake know a subscription a webhook announced. */
    put(sub: PaddleSubscriptionData) {
      subscriptions.set(sub.id, structuredClone(sub));
    },
    failNextCall(error: Error) {
      failNext = error;
    },
  };
}

export type FakePaddle = ReturnType<typeof fakePaddleApi>;

export function buildBillingApp(clock: Clock, paddle?: FakePaddle) {
  const ctx = buildContainerApp({
    authRateLimit: false,
    clock,
    env: PADDLE_ENV,
    ...(paddle === undefined ? {} : { paddleApi: paddle.api }),
  });
  const moduleOf = <T>(name: string) => ctx.container.modules.find((m) => m.name === name) as T;
  return {
    ...ctx,
    billing: moduleOf<BillingModule>("billing"),
    monitors: moduleOf<MonitorsModule>("monitors"),
    workspaces: moduleOf<WorkspacesModule>("workspaces"),
  };
}

export type BillingApp = ReturnType<typeof buildBillingApp>;

export const post = (agent: TestAgent, path: string, body: object = {}) =>
  agent.post(path).set("Origin", WEB_ORIGIN).send(body);
export const get = (agent: TestAgent, path: string) => agent.get(path).set("Origin", WEB_ORIGIN);

export async function signUpWithWorkspace(ctx: BillingApp, label: string) {
  const agent = request.agent(ctx.app);
  const email = `${label}-${randomBytes(4).toString("hex")}@example.com`;
  await signUpVerified(ctx, agent, email);
  const created = await post(agent, "/api/auth/organization/create", {
    name: `${label} Co`,
    slug: `${label}-${randomBytes(4).toString("hex")}`,
  });
  expect(created.status, created.text).toBe(200);
  const session = await get(agent, "/api/auth/get-session");
  return {
    agent,
    email,
    workspaceId: created.body.id as string,
    userId: session.body.user.id as string,
  };
}

const iso = (date: Date) => date.toISOString();
let sequence = 0;
const nextId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${(sequence += 1).toString(36)}${randomBytes(3).toString("hex")}`;

export interface SubscriptionInput {
  id?: string;
  status?: PaddleSubscriptionData["status"];
  priceId: string;
  extraItems?: PaddleItem[];
  periodStart: Date;
  periodEnd: Date;
  customData?: Record<string, unknown> | null;
  discountId?: string | null;
  scheduledChange?: PaddleSubscriptionData["scheduledChange"];
  customerId?: string;
}

/* A subscription as Paddle would describe it, in both the API form and the webhook form. */
export function subscriptionFixture(input: SubscriptionInput, updatedAt: Date) {
  const data: PaddleSubscriptionData = {
    id: input.id ?? nextId("sub"),
    status: input.status ?? "active",
    customerId: input.customerId ?? "ctm_test01",
    items: [{ priceId: input.priceId, quantity: 1 }, ...(input.extraItems ?? [])],
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    scheduledChange: input.scheduledChange ?? null,
    discountId: input.discountId ?? null,
    customData: input.customData ?? null,
    canceledAt: input.status === "canceled" ? updatedAt : null,
    updatedAt,
  };
  return data;
}

export function subscriptionPayload(data: PaddleSubscriptionData) {
  return {
    id: data.id,
    status: data.status,
    customer_id: data.customerId,
    items: data.items.map((i) => ({ price: { id: i.priceId }, quantity: i.quantity })),
    current_billing_period:
      data.periodStart === null || data.periodEnd === null
        ? null
        : { starts_at: iso(data.periodStart), ends_at: iso(data.periodEnd) },
    scheduled_change:
      data.scheduledChange === null
        ? null
        : {
            action: data.scheduledChange.action,
            effective_at: iso(data.scheduledChange.effectiveAt),
            resume_at: null,
          },
    discount: data.discountId === null ? null : { id: data.discountId },
    custom_data: data.customData,
    canceled_at: data.canceledAt === null ? null : iso(data.canceledAt),
    updated_at: iso(data.updatedAt),
  };
}

export function transactionPayload(input: {
  id?: string;
  subscriptionId?: string | null;
  origin?: string;
  items: PaddleItem[];
  period?: { startsAt: Date; endsAt: Date } | null;
  customData?: Record<string, unknown> | null;
  status?: string;
}) {
  return {
    id: input.id ?? nextId("txn"),
    status: input.status ?? "completed",
    origin: input.origin ?? "web",
    subscription_id: input.subscriptionId ?? null,
    customer_id: "ctm_test01",
    items: input.items.map((i) => ({ price: { id: i.priceId }, quantity: i.quantity })),
    custom_data: input.customData ?? null,
    billing_period: input.period
      ? { starts_at: iso(input.period.startsAt), ends_at: iso(input.period.endsAt) }
      : null,
  };
}

export function paddleEvent(type: string, data: unknown, occurredAt: Date, eventId?: string) {
  return {
    event_id: eventId ?? nextId("evt"),
    event_type: type,
    occurred_at: iso(occurredAt),
    notification_id: nextId("ntf"),
    data,
  };
}

export function signPaddle(body: string, secret = PADDLE_WEBHOOK_SECRET, at = Date.now()) {
  const ts = Math.floor(at / 1_000);
  const h1 = createHmac("sha256", secret).update(`${ts}:${body}`).digest("hex");
  return `ts=${ts};h1=${h1}`;
}

/* Delivers a webhook over HTTP with Paddle's signature. */
export function deliver(ctx: BillingApp, event: object, signature?: string) {
  const body = JSON.stringify(event);
  return request(ctx.app)
    .post("/api/webhooks/paddle")
    .set("content-type", "application/json")
    .set("paddle-signature", signature ?? signPaddle(body))
    .send(body);
}

/* Delivers a webhook and runs its job, as the worker would. Returns what processing did. */
export async function deliverAndProcess(ctx: BillingApp, event: { event_id: string }) {
  const res = await deliver(ctx, event);
  expect(res.status, res.text).toBe(200);
  return ctx.billing.sync.process(event.event_id);
}

/* Custom data as our checkout endpoint issues it. */
export async function checkoutData(
  owner: { agent: TestAgent; workspaceId: string },
  plan = "starter",
  interval = "month",
) {
  const res = await post(owner.agent, `/api/w/${owner.workspaceId}/billing/checkout`, {
    plan,
    interval,
  });
  expect(res.status, res.text).toBe(200);
  return res.body.customData as Record<string, unknown>;
}

/* Outbox events of one type for a workspace, newest first. */
export async function eventsOf(ctx: BillingApp, workspaceId: string, type: string) {
  const rows = await ctx.container.infra.db
    .select({ payload: outboxEvents.payload })
    .from(outboxEvents)
    .where(and(eq(outboxEvents.workspaceId, workspaceId), eq(outboxEvents.type, type)))
    .orderBy(desc(outboxEvents.createdAt), desc(outboxEvents.id));
  return rows.map((r) => r.payload as Record<string, unknown>);
}

/* Billing emails requested for a workspace, by kind. */
export async function billingEmails(ctx: BillingApp, workspaceId: string, kind: string) {
  const all = await eventsOf(ctx, workspaceId, "email.requested");
  return all.filter((p) => p.template === "billing" && (p.data as { kind?: string }).kind === kind);
}
