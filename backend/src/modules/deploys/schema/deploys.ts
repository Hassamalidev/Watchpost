/*
 * Tables owned by the deploys module (P1-T26). deploy_hooks holds each workspace's hashed deploy URL
 * token (one per workspace; rotating replaces it). deploys is the deploy log that "what changed"
 * timelines and alert explanations read; GitHub deliveries carry an external ID so retries don't
 * record a deploy twice.
 */
import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organization } from "../../../infra/auth/schema.js";

export type DeploySource = "api" | "github";

export const deployHooks = pgTable(
  "deploy_hooks",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /* SHA-256 of the URL token; the token itself is shown once. */
    tokenHash: text("token_hash").notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("deploy_hooks_workspace_idx").on(t.workspaceId),
    uniqueIndex("deploy_hooks_token_idx").on(t.tokenHash),
  ],
);

export const deploys = pgTable(
  "deploys",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    source: text("source").$type<DeploySource>().notNull(),
    externalId: text("external_id"),
    service: text("service"),
    version: text("version").notNull(),
    environment: text("environment"),
    url: text("url"),
    description: text("description"),
    deployedAt: timestamp("deployed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("deploys_workspace_time_idx").on(t.workspaceId, t.deployedAt),
    uniqueIndex("deploys_external_idx")
      .on(t.workspaceId, t.externalId)
      .where(sql`${t.externalId} is not null`),
  ],
);

export type DeployHookRow = typeof deployHooks.$inferSelect;
export type DeployRow = typeof deploys.$inferSelect;
