/*
 * Tables owned by the apikeys module (PRODUCT.md §7.4, §8). A key is stored as a hash: the key
 * itself is shown once, when it is made. `idempotency_keys` remembers the answer to a write for 24
 * hours, so a script that retries doesn't do the work twice.
 */
import type { ApiScope } from "@app/shared";
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "../../../infra/auth/schema.js";

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /* The first part of the key, which finds the row; shown in lists to tell keys apart. */
    prefix: text("prefix").notNull(),
    /* SHA-256 of the whole key, hex. */
    hash: text("hash").notNull(),
    scopes: text("scopes").array().$type<ApiScope[]>().notNull(),
    /* Who made it; kept for the record after that person leaves. */
    createdBy: uuid("created_by"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("api_keys_prefix_uq").on(t.prefix),
    index("api_keys_workspace_idx").on(t.workspaceId),
  ],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    /* Method, path and body of the request the key was first used with. */
    fingerprint: text("fingerprint").notNull(),
    /* Null while the first request is still being handled. */
    status: integer("status"),
    response: jsonb("response"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.key] }),
    index("idempotency_keys_created_idx").on(t.createdAt),
  ],
);
