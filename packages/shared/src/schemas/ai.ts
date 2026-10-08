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

/* How a public status update should sound (§6.6). */
export const STATUS_TONES = ["neutral", "friendly", "formal"] as const;
export type StatusTone = (typeof STATUS_TONES)[number];

/* A status page update written by the model: text for the public, nothing else. */
export const aiStatusUpdateSchema = z
  .object({ message: z.string().trim().min(1).max(800) })
  .strict();
export type AiStatusUpdate = z.infer<typeof aiStatusUpdateSchema>;

/*
 * What the model contributes to a postmortem: judgement and wording. The facts (times, durations,
 * who did what) are filled in from our own records, never from the model.
 */
export const aiPostmortemSchema = z
  .object({
    summary: z.string().trim().min(1).max(800),
    impact: z.string().trim().min(1).max(600),
    rootCause: z.string().trim().min(1).max(800),
    whatWentWell: z.array(z.string().trim().min(1).max(300)).max(6),
    whatWentWrong: z.array(z.string().trim().min(1).max(300)).max(6),
    actionItems: z.array(z.string().trim().min(1).max(300)).max(8),
  })
  .strict();
export type AiPostmortem = z.infer<typeof aiPostmortemSchema>;

export const POSTMORTEM_MAX_CHARS = 50_000;
export const savePostmortemSchema = z
  .object({ markdown: z.string().max(POSTMORTEM_MAX_CHARS) })
  .strict();

export interface PostmortemView {
  markdown: string;
  /* The text started as an AI draft (it may have been edited since). */
  aiDrafted: boolean;
  updatedAt: string;
}

export const aiFeedbackSchema = z.object({ feedback: z.enum(AI_FEEDBACK).nullable() }).strict();
