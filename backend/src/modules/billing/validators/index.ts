/* Zod request schemas for the billing API. */
import { z } from "zod";
import { BILLING_INTERVALS, CANCEL_REASONS, CREDIT_PACKS } from "@app/shared";
import { PAID_PLAN_KEYS } from "../../../config/plans.js";

export const planBody = z
  .object({
    plan: z.enum(PAID_PLAN_KEYS),
    interval: z.enum(BILLING_INTERVALS).default("month"),
  })
  .strict();

export const buyCreditsBody = z
  .object({
    credits: z
      .number()
      .int()
      .refine((n): n is (typeof CREDIT_PACKS)[number] => CREDIT_PACKS.some((c) => c === n), {
        message: `must be one of ${CREDIT_PACKS.join(", ")}`,
      }),
  })
  .strict();

export const cancelBody = z
  .object({
    reason: z.enum(CANCEL_REASONS),
    comment: z.string().trim().max(1_000).optional(),
  })
  .strict();
