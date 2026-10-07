/*
 * AI output shapes (PRODUCT.md §6.9, §9.10). The model's answer is validated against these before
 * anyone sees it; the same types describe what the API returns and the web app shows, always
 * labeled "AI".
 */
import { z } from "zod";

export const AI_CONFIDENCE = ["low", "medium", "high"] as const;
export const AI_FEEDBACK = ["up", "down"] as const;
export type AiFeedback = (typeof AI_FEEDBACK)[number];

/* What the incident explainer says about one incident. */
export const aiExplanationSchema = z
  .object({
    headline: z.string().trim().min(1).max(120),
    likelyCause: z.string().trim().min(1).max(600),
    confidence: z.enum(AI_CONFIDENCE),
    /* Names of the evidence fields the answer rests on ("causeCode", "timing"); never free text. */
    evidenceRefs: z.array(z.string().trim().min(1).max(60)).max(8),
    nextChecks: z.array(z.string().trim().min(1).max(200)).max(5),
  })
  .strict();
export type AiExplanation = z.infer<typeof aiExplanationSchema>;

/* An explanation as the incident page shows it. */
export interface AiSummaryView extends AiExplanation {
  generationId: string;
  model: string;
  createdAt: string;
  feedback: AiFeedback | null;
}

export const aiFeedbackSchema = z.object({ feedback: z.enum(AI_FEEDBACK).nullable() }).strict();
