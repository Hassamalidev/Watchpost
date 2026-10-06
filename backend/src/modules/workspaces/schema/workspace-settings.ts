/*
 * workspace_settings: one row per workspace (Better Auth organization), owned by the workspaces
 * module (PRODUCT.md §8). Keyed by workspace_id like every tenant table.
 */
import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "../../../infra/auth/schema.js";

export const workspaceSettings = pgTable("workspace_settings", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  /* IANA zone for schedules, reports and display. */
  timezone: text("timezone").notNull().default("UTC"),
  /* Last incident number handed out; incidents are numbered #1, #2, … per workspace. */
  incidentSeq: integer("incident_seq").notNull().default(0),
  /* End of the card-less 14-day Pro trial (PRODUCT.md §5); null once converted or never trialled. */
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
  /* Per-workspace feature flags (PRODUCT.md §7.11). */
  flags: jsonb("flags").$type<Record<string, boolean>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type WorkspaceSettingsRow = typeof workspaceSettings.$inferSelect;
