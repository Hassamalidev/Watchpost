/*
 * The Paddle adapter without the network: real signature verification (the SDK's HMAC check with its
 * replay window) and the webhook parser against Paddle's documented payload shapes.
 */
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { PADDLE_PRICE_ENV } from "../../config/env.js";
import { syncCatalog, type CatalogClient, type CatalogObject } from "../paddle/catalog.js";
import { createPaddle, parsePaddleEnvelope, parsePaddleWebhook } from "../paddle/index.js";

const SECRET = "pdl_ntfset_unit_secret_0123456789";
const paddle = createPaddle({
  apiKey: "pdl_sdbx_apikey_unit",
  webhookSecret: SECRET,
  environment: "sandbox",
});

function sign(body: string, secret = SECRET, at = Date.now()) {
  const ts = Math.floor(at / 1_000);
  return `ts=${ts};h1=${createHmac("sha256", secret).update(`${ts}:${body}`).digest("hex")}`;
}

const subscription = {
  id: "sub_01h04vsc0qhwtsbsxh3422wjs4",
  status: "active",
  customer_id: "ctm_01grnn4zta5a1mf02jjze7y2ys",
  address_id: "add_01gm302t81w94gyjpjpqypkzkf",
  currency_code: "USD",
  created_at: "2026-10-12T07:20:50.52Z",
  updated_at: "2026-10-12T07:20:50.52Z",
  next_billed_at: "2026-11-12T07:20:50.52Z",
  canceled_at: null,
  collection_mode: "automatic",
  billing_cycle: { interval: "month", frequency: 1 },
  current_billing_period: {
    starts_at: "2026-10-12T07:20:50.52Z",
    ends_at: "2026-11-12T07:20:50.52Z",
  },
  scheduled_change: { action: "cancel", effective_at: "2026-11-12T07:20:50.52Z", resume_at: null },
  items: [
    {
      price: { id: "pri_01gsz8z1q1n00f12qt82y31smh" },
      product: { id: "pro_1" },
      quantity: 1,
      status: "active",
    },
  ],
  discount: null,
  custom_data: { workspaceId: "w", userId: "u", sig: "s" },
};

const envelope = (type: string, data: unknown) => ({
  event_id: "evt_01gks14ge726w50ch2tmaw2a1x",
  event_type: type,
  occurred_at: "2026-10-12T07:20:51.52Z",
  notification_id: "ntf_01ghbkd0frb9k95cnhwd1bxpvk",
  data,
});

describe("Paddle webhook signatures", () => {
  const body = JSON.stringify(envelope("subscription.updated", subscription));

  it("accepts a body signed with our secret", async () => {
    expect(await paddle.webhooks.verify(body, sign(body))).toBe(true);
  });

  it("refuses everything else", async () => {
    expect(await paddle.webhooks.verify(body, undefined)).toBe(false);
    expect(await paddle.webhooks.verify(body, "")).toBe(false);
    expect(await paddle.webhooks.verify(body, "not a signature")).toBe(false);
    expect(await paddle.webhooks.verify(body, sign(body, "pdl_ntfset_other_secret_000"))).toBe(
      false,
    );
    expect(await paddle.webhooks.verify(`${body} `, sign(body))).toBe(false);
    /* Older than the SDK's 5-second replay window. */
    expect(await paddle.webhooks.verify(body, sign(body, SECRET, Date.now() - 30_000))).toBe(false);
  });
});

describe("parsePaddleWebhook", () => {
  it("reads a subscription event", () => {
    const event = parsePaddleWebhook(envelope("subscription.updated", subscription));
    if (event.kind !== "subscription") throw new Error("expected a subscription event");
    expect(event).toMatchObject({
      eventId: "evt_01gks14ge726w50ch2tmaw2a1x",
      type: "subscription.updated",
    });
    expect(event.occurredAt.toISOString()).toBe("2026-10-12T07:20:51.520Z");
    expect(event.subscription).toMatchObject({
      id: "sub_01h04vsc0qhwtsbsxh3422wjs4",
      status: "active",
      customerId: "ctm_01grnn4zta5a1mf02jjze7y2ys",
      items: [{ priceId: "pri_01gsz8z1q1n00f12qt82y31smh", quantity: 1 }],
      discountId: null,
      customData: { workspaceId: "w", userId: "u", sig: "s" },
    });
    expect(event.subscription.periodEnd?.toISOString()).toBe("2026-11-12T07:20:50.520Z");
    expect(event.subscription.scheduledChange).toMatchObject({ action: "cancel", resumeAt: null });
  });

  it("reads a transaction event, with or without a billing period", () => {
    const base = {
      id: "txn_01h",
      status: "completed",
      origin: "subscription_recurring",
      subscription_id: "sub_1",
      customer_id: "ctm_1",
      items: [{ price: { id: "pri_a" }, quantity: 2 }],
      custom_data: null,
    };
    const withPeriod = parsePaddleWebhook(
      envelope("transaction.completed", {
        ...base,
        billing_period: { starts_at: "2026-10-12T00:00:00Z", ends_at: "2026-11-12T00:00:00Z" },
      }),
    );
    if (withPeriod.kind !== "transaction") throw new Error("expected a transaction event");
    expect(withPeriod.transaction).toMatchObject({
      id: "txn_01h",
      origin: "subscription_recurring",
      subscriptionId: "sub_1",
      items: [{ priceId: "pri_a", quantity: 2 }],
    });
    expect(withPeriod.transaction.billingPeriod?.endsAt.toISOString()).toBe(
      "2026-11-12T00:00:00.000Z",
    );
    const oneTime = parsePaddleWebhook(
      envelope("transaction.completed", { ...base, subscription_id: null }),
    );
    if (oneTime.kind !== "transaction") throw new Error("expected a transaction event");
    expect(oneTime.transaction).toMatchObject({ subscriptionId: null, billingPeriod: null });
  });

  it("passes other events through and rejects malformed ones", () => {
    expect(parsePaddleWebhook(envelope("customer.created", { id: "ctm_1" })).kind).toBe("other");
    expect(() => parsePaddleWebhook(envelope("subscription.updated", { id: "sub_1" }))).toThrow();
    expect(() => parsePaddleWebhook({ event_type: "subscription.updated" })).toThrow();
    expect(parsePaddleEnvelope({ hello: "world" })).toBeUndefined();
    expect(parsePaddleEnvelope(envelope("x.y", null))).toMatchObject({ type: "x.y" });
  });
});

describe("catalog sync", () => {
  function fakeCatalog() {
    const products: CatalogObject[] = [];
    const prices: Array<CatalogObject & { amountCents: number; interval: string | null }> = [];
    const discounts: CatalogObject[] = [];
    let n = 0;
    const client: CatalogClient = {
      listProducts: async () => products,
      createProduct: async ({ key }) => {
        products.push({ id: `pro_${(n += 1)}`, key });
        return `pro_${n}`;
      },
      listPrices: async () => prices,
      createPrice: async ({ key, amountCents, interval }) => {
        prices.push({ id: `pri_${(n += 1)}`, key, amountCents, interval });
        return `pri_${n}`;
      },
      listDiscounts: async () => discounts,
      createDiscount: async ({ key, percent, usageLimit }) => {
        expect({ percent, usageLimit }).toEqual({ percent: 30, usageLimit: 100 });
        discounts.push({ id: `dsc_${(n += 1)}`, key });
        return `dsc_${n}`;
      },
    };
    return { client, products, prices, discounts };
  }

  it("creates every product, price and the founding discount once", async () => {
    const fake = fakeCatalog();
    const first = await syncCatalog(fake.client);
    expect(Object.keys(first.env).sort()).toEqual(
      [...PADDLE_PRICE_ENV, "PADDLE_DISCOUNT_FOUNDING"].sort(),
    );
    expect(fake.products).toHaveLength(7);
    expect(fake.prices).toHaveLength(11);
    const amount = (key: string) => fake.prices.find((p) => p.key === key);
    expect(amount("starter_monthly")).toMatchObject({ amountCents: 900, interval: "month" });
    expect(amount("starter_annual")).toMatchObject({ amountCents: 9_000, interval: "year" });
    expect(amount("pro_annual")).toMatchObject({ amountCents: 28_800 });
    expect(amount("business_annual")).toMatchObject({ amountCents: 79_200 });
    expect(amount("credits_500")).toMatchObject({ amountCents: 2_500, interval: null });

    /* A second run finds everything by key and creates nothing. */
    const second = await syncCatalog(fake.client);
    expect(second.created).toEqual([]);
    expect(second.env).toEqual(first.env);
    expect(fake.prices).toHaveLength(11);
  });

  it("creates only what is missing", async () => {
    const fake = fakeCatalog();
    await syncCatalog(fake.client);
    fake.prices.splice(
      fake.prices.findIndex((p) => p.key === "pro_monthly"),
      1,
    );
    const again = await syncCatalog(fake.client);
    expect(again.created).toEqual(["pro_monthly"]);
  });
});
