/* Zod request schemas for the alert policies API, built from @app/shared. */
import { z } from "zod";
import { alertPolicyBodySchema, alertPolicyRulesSchema } from "@app/shared";

export const policyIdParams = z.object({ policyId: z.uuid() });
export const channelIdParams = z.object({ channelId: z.uuid() });
export const incidentIdParams = z.object({ incidentId: z.uuid() });
export const createPolicyBody = alertPolicyBodySchema;
export const updatePolicyBody = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    rules: alertPolicyRulesSchema.optional(),
  })
  .strict()
  .refine((b) => b.name !== undefined || b.rules !== undefined, "nothing to update");
