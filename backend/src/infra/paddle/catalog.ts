/*
 * The Paddle catalog (PRODUCT.md §11 "Catalog"): the products, prices and the founding discount this
 * product sells, created idempotently. Every object carries `custom_data.key`; a second run finds the
 * existing objects by that key and creates only what is missing, so it is safe to re-run after adding
 * a plan. Amounts come from `config/plans.ts`, the same numbers the pricing page shows.
 */
import { Environment, Paddle } from "@paddle/paddle-node-sdk";
import {
  ADDON_MONTHLY_USD,
  CREDIT_PACK_USD,
  PAID_PLAN_KEYS,
  PLANS,
  type AddonKey,
} from "../../config/plans.js";

export interface CatalogObject {
  id: string;
  key: string | undefined;
}

/* The few Paddle calls the catalog needs, so tests run it against an in-memory fake. */
export interface CatalogClient {
  listProducts(): Promise<CatalogObject[]>;
  createProduct(input: { key: string; name: string; description: string }): Promise<string>;
  listPrices(): Promise<CatalogObject[]>;
  createPrice(input: {
    key: string;
    productId: string;
    description: string;
    /* Paddle takes amounts in the smallest unit as a string ("900" is $9.00). */
    amountCents: number;
    interval: "month" | "year" | null;
    /* How many of this price one purchase may hold (a plan: 1; packs and add-ons: several). */
    maxQuantity: number;
  }): Promise<string>;
  listDiscounts(): Promise<CatalogObject[]>;
  createDiscount(input: { key: string; description: string; percent: number }): Promise<string>;
}

interface PriceSpec {
  key: string;
  env: string;
  description: string;
  amountCents: number;
  interval: "month" | "year" | null;
  maxQuantity: number;
}

interface ProductSpec {
  key: string;
  name: string;
  description: string;
  prices: PriceSpec[];
}

const cents = (usd: number) => Math.round(usd * 100);

const ADDON_SPECS: Record<AddonKey, { env: string; name: string; description: string }> = {
  extraMonitors100: {
    env: "PADDLE_PRICE_EXTRA_MONITORS_100",
    name: "Watchpost: 100 extra monitors",
    description: "100 more monitors on Pro and Business",
  },
  extraProbe: {
    env: "PADDLE_PRICE_EXTRA_PROBE",
    name: "Watchpost: extra private probe",
    description: "One more private probe",
  },
  extraClientWorkspace: {
    env: "PADDLE_PRICE_EXTRA_CLIENT_WORKSPACE",
    name: "Watchpost: extra client workspace",
    description: "One more client workspace on Business",
  },
};

export function catalogSpec(): ProductSpec[] {
  const plans: ProductSpec[] = PAID_PLAN_KEYS.map((plan) => ({
    key: `plan_${plan}`,
    name: `Watchpost ${PLANS[plan].name}`,
    description: `Watchpost ${PLANS[plan].name} plan`,
    prices: [
      {
        key: `${plan}_monthly`,
        env: `PADDLE_PRICE_${plan.toUpperCase()}_MONTHLY`,
        description: `${PLANS[plan].name}, billed monthly`,
        amountCents: cents(PLANS[plan].monthlyUsd),
        interval: "month",
        maxQuantity: 1,
      },
      {
        key: `${plan}_annual`,
        env: `PADDLE_PRICE_${plan.toUpperCase()}_ANNUAL`,
        description: `${PLANS[plan].name}, billed annually`,
        amountCents: cents(PLANS[plan].annualMonthlyUsd * 12),
        interval: "year",
        maxQuantity: 1,
      },
    ],
  }));
  const credits: ProductSpec = {
    key: "credits",
    name: "Watchpost SMS and voice credits",
    description: "Credits for SMS, voice and WhatsApp alerts",
    prices: ([100, 500] as const).map((pack) => ({
      key: `credits_${pack}`,
      env: `PADDLE_PRICE_CREDITS_${pack}`,
      description: `${pack} credits`,
      amountCents: cents(CREDIT_PACK_USD[pack]),
      interval: null,
      maxQuantity: 20,
    })),
  };
  const addons: ProductSpec[] = (Object.keys(ADDON_SPECS) as AddonKey[]).map((addon) => ({
    key: `addon_${addon}`,
    name: ADDON_SPECS[addon].name,
    description: ADDON_SPECS[addon].description,
    prices: [
      {
        key: `addon_${addon}_monthly`,
        env: ADDON_SPECS[addon].env,
        description: `${ADDON_SPECS[addon].description}, billed monthly`,
        amountCents: cents(ADDON_MONTHLY_USD[addon]),
        interval: "month",
        maxQuantity: 50,
      },
    ],
  }));
  return [...plans, credits, ...addons];
}

export const FOUNDING_DISCOUNT = {
  key: "founding_30",
  env: "PADDLE_DISCOUNT_FOUNDING",
  description: "Founding customer: 30% off for life",
  percent: 30,
} as const;

export interface CatalogResult {
  /* Environment lines to put in .env (price IDs differ between sandbox and live). */
  env: Record<string, string>;
  /* Keys of the objects this run created; empty when the catalog was already complete. */
  created: string[];
}

export async function syncCatalog(client: CatalogClient): Promise<CatalogResult> {
  const env: Record<string, string> = {};
  const created: string[] = [];
  const index = (objects: CatalogObject[]) =>
    new Map(objects.flatMap((o) => (o.key === undefined ? [] : [[o.key, o.id] as const])));
  const products = index(await client.listProducts());
  const prices = index(await client.listPrices());
  const discounts = index(await client.listDiscounts());

  for (const product of catalogSpec()) {
    let productId = products.get(product.key);
    if (productId === undefined) {
      productId = await client.createProduct({
        key: product.key,
        name: product.name,
        description: product.description,
      });
      created.push(product.key);
    }
    for (const price of product.prices) {
      let priceId = prices.get(price.key);
      if (priceId === undefined) {
        priceId = await client.createPrice({
          key: price.key,
          productId,
          description: price.description,
          amountCents: price.amountCents,
          interval: price.interval,
          maxQuantity: price.maxQuantity,
        });
        created.push(price.key);
      }
      env[price.env] = priceId;
    }
  }

  let discountId = discounts.get(FOUNDING_DISCOUNT.key);
  if (discountId === undefined) {
    discountId = await client.createDiscount({
      key: FOUNDING_DISCOUNT.key,
      description: FOUNDING_DISCOUNT.description,
      percent: FOUNDING_DISCOUNT.percent,
    });
    created.push(FOUNDING_DISCOUNT.key);
  }
  env[FOUNDING_DISCOUNT.env] = discountId;
  return { env, created };
}

const keyOf = (customData: unknown): string | undefined => {
  const key = (customData as { key?: unknown } | null)?.key;
  return typeof key === "string" ? key : undefined;
};

async function all<T>(collection: { hasMore: boolean; next(): Promise<T[]> }): Promise<T[]> {
  const items: T[] = [];
  do {
    items.push(...(await collection.next()));
  } while (collection.hasMore);
  return items;
}

export function createSdkCatalogClient(options: {
  apiKey: string;
  environment: "sandbox" | "production";
}): CatalogClient {
  const paddle = new Paddle(options.apiKey, {
    environment:
      options.environment === "production" ? Environment.production : Environment.sandbox,
  });
  return {
    async listProducts() {
      const rows = await all(paddle.products.list({ perPage: 200 }));
      return rows.map((p) => ({ id: p.id, key: keyOf(p.customData) }));
    },
    async createProduct({ key, name, description }) {
      const product = await paddle.products.create({
        name,
        description,
        taxCategory: "saas",
        customData: { key },
      });
      return product.id;
    },
    async listPrices() {
      const rows = await all(paddle.prices.list({ perPage: 200 }));
      return rows.map((p) => ({ id: p.id, key: keyOf(p.customData) }));
    },
    async createPrice({ key, productId, description, amountCents, interval, maxQuantity }) {
      const price = await paddle.prices.create({
        productId,
        description,
        unitPrice: { amount: String(amountCents), currencyCode: "USD" },
        billingCycle: interval === null ? null : { interval, frequency: 1 },
        quantity: { minimum: 1, maximum: maxQuantity },
        customData: { key },
      });
      return price.id;
    },
    async listDiscounts() {
      const rows = await all(paddle.discounts.list({ perPage: 200 }));
      return rows.map((d) => ({ id: d.id, key: keyOf(d.customData) }));
    },
    async createDiscount({ key, description, percent }) {
      const discount = await paddle.discounts.create({
        description,
        type: "percentage",
        amount: String(percent),
        /* Applies to every renewal, for as long as the subscription lives. */
        recur: true,
        maximumRecurringIntervals: null,
        enabledForCheckout: true,
        customData: { key },
      });
      return discount.id;
    },
  };
}
