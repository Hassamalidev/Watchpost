/*
 * Tables owned by the expiry module (PRODUCT.md §8, §9.8). expiry_notices makes each warning
 * threshold fire once per subject (a certificate fingerprint or a domain's expiry date, so a renewal
 * starts a new cycle). domain_expiry_cache is shared across workspaces; rdap_bootstrap caches IANA's
 * RDAP service list for a week; ssl_state remembers each monitor's certificate to spot changes.
 */
import { index, pgTable, text, timestamp, integer, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export type ExpiryKind = "ssl" | "domain";
export type DomainLookupStatus = "ok" | "unsupported" | "error";

export const expiryNotices = pgTable(
  "expiry_notices",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    monitorId: uuid("monitor_id").notNull(),
    kind: text("kind").$type<ExpiryKind>().notNull(),
    /* Certificate fingerprint or domain expiry date: what the warning is about. */
    subject: text("subject").notNull(),
    threshold: integer("threshold").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("expiry_notices_uq").on(t.monitorId, t.kind, t.subject, t.threshold)],
);

export const domainExpiryCache = pgTable("domain_expiry_cache", {
  domain: text("domain").primaryKey(),
  status: text("status").$type<DomainLookupStatus>().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  registrar: text("registrar"),
  source: text("source"),
  error: text("error"),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
});

export const rdapBootstrap = pgTable("rdap_bootstrap", {
  tld: text("tld").primaryKey(),
  /* RDAP base URLs for the TLD, in IANA's order. */
  urls: text("urls").array().notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
});

export const sslState = pgTable(
  "ssl_state",
  {
    monitorId: uuid("monitor_id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validTo: timestamp("valid_to", { withTimezone: true }).notNull(),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("ssl_state_workspace_idx").on(t.workspaceId)],
);

export type DomainExpiryRow = typeof domainExpiryCache.$inferSelect;
export type SslStateRow = typeof sslState.$inferSelect;
