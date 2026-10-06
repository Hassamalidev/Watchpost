/*
 * Tables owned by the credits module (PRODUCT.md §8, §11 "Upstream funding").
 * - credit_balances: one row per workspace. The row lock serializes every change to a workspace's
 *   credits; `included` is the plan's monthly allowance (it expires), `purchased` never expires.
 * - credit_ledger: every change to a balance, append-only. The balance always equals the sum of the
 *   ledger; the unique index makes grants, purchases, charges and refunds idempotent.
 * - usage_ledger: what each paid external call cost us (SMS, voice, AI tokens), in micro-USD.
 * - provider_funding: what each customer payment set aside for a provider. We spend at a provider
 *   only against money a customer already paid (or the small platform allowance for free plans).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { CreditBucket } from "@app/shared";
import { organization } from "../../../infra/auth/schema.js";

export type CreditReason = "grant" | "grant_upgrade" | "purchase" | "charge" | "refund" | "expire";
export type Provider = "anthropic" | "twilio";
export type FundingSource = "subscription" | "credit_pack";

export const creditBalances = pgTable("credit_balances", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  included: integer("included").notNull().default(0),
  purchased: integer("purchased").notNull().default(0),
  /* The grant the included credits came from (`<subscription>:<window start>`) and its size. */
  grantRef: text("grant_ref"),
  granted: integer("granted").notNull().default(0),
  includedGrantedAt: timestamp("included_granted_at", { withTimezone: true }),
  /* Included credits are worth nothing from this moment: the month's end plus a renewal grace. */
  includedExpiresAt: timestamp("included_expires_at", { withTimezone: true }),
  /* Set when the low-balance email went out; cleared by the next grant or purchase. */
  lowNotifiedAt: timestamp("low_notified_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    bucket: text("bucket").$type<CreditBucket>().notNull(),
    delta: integer("delta").notNull(),
    reason: text("reason").$type<CreditReason>().notNull(),
    /* What the entry is for: a grant window, a Paddle transaction, a delivery, a charged entry. */
    refId: text("ref_id").notNull(),
    /* Charges remember their incident, so a false alarm can give the credits back. */
    incidentId: uuid("incident_id"),
    /* The bucket's balance after this entry. */
    balanceAfter: integer("balance_after").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /* A charge can take from both buckets, so the bucket is part of the key. */
    uniqueIndex("credit_ledger_ref_uq").on(t.workspaceId, t.reason, t.refId, t.bucket),
    index("credit_ledger_workspace_time_idx").on(t.workspaceId, t.createdAt),
    index("credit_ledger_incident_idx")
      .on(t.incidentId)
      .where(sql`${t.incidentId} is not null`),
  ],
);

export const usageLedger = pgTable(
  "usage_ledger",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    provider: text("provider").$type<Provider>().notNull(),
    /* sms, voice, whatsapp, explainer, digest, … */
    kind: text("kind").notNull(),
    units: integer("units").notNull(),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull(),
    /* The provider call this row meters (a delivery ID, a generation ID); makes metering idempotent. */
    ref: text("ref").notNull(),
    /* True when a collected payment covered the workspace at the time; false is platform-paid. */
    funded: boolean("funded").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("usage_ledger_ref_uq").on(t.provider, t.ref),
    index("usage_ledger_workspace_idx").on(t.workspaceId, t.provider, t.createdAt),
    index("usage_ledger_provider_time_idx").on(t.provider, t.createdAt),
  ],
);

export const providerFunding = pgTable(
  "provider_funding",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    provider: text("provider").$type<Provider>().notNull(),
    source: text("source").$type<FundingSource>().notNull(),
    /* The grant window or the Paddle transaction that paid for it. */
    ref: text("ref").notNull(),
    amountMicros: bigint("amount_micros", { mode: "number" }).notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    /* Null for credit packs: purchased credits never expire. */
    periodEnd: timestamp("period_end", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("provider_funding_ref_uq").on(t.provider, t.ref),
    index("provider_funding_workspace_idx").on(t.workspaceId, t.provider, t.periodStart),
  ],
);

export type CreditBalanceRow = typeof creditBalances.$inferSelect;
export type CreditLedgerRow = typeof creditLedger.$inferSelect;
