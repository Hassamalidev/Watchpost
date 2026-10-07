/*
 * Tables owned by the ai module (PRODUCT.md §7.4, §8). One row per attempt to generate something:
 * what it was for, which prompt version and model, what it cost, how it ended, and the answer when
 * there is one. Feedback (👍/👎) is stored on the row for evaluation (§9.10).
 */
import type { AiFeedback } from "@app/shared";
import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "../../../infra/auth/schema.js";

/* `ok`: an answer was stored. `failed`: the call or its answer was no good. `skipped`: not called. */
export type GenerationStatus = "ok" | "failed" | "skipped";

export const aiGenerations = pgTable(
  "ai_generations",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /* The prompt's key ("explainer"). */
    kind: text("kind").notNull(),
    promptVersion: integer("prompt_version").notNull(),
    /* What it is about (an incident ID). */
    refId: uuid("ref_id").notNull(),
    model: text("model"),
    status: text("status").$type<GenerationStatus>().notNull(),
    /* Why it failed or was skipped: budget_used, disabled, circuit_open, timeout, invalid_output … */
    reason: text("reason"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costMicros: integer("cost_micros").notNull().default(0),
    output: jsonb("output").$type<Record<string, unknown>>(),
    feedback: text("feedback").$type<AiFeedback>(),
    feedbackBy: uuid("feedback_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ai_generations_ref_idx").on(t.workspaceId, t.kind, t.refId, t.createdAt.desc()),
    index("ai_generations_feedback_idx")
      .on(t.kind, t.promptVersion)
      .where(sql`${t.feedback} is not null`),
  ],
);

export type AiGenerationRow = typeof aiGenerations.$inferSelect;
