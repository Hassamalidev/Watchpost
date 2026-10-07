/* Zod request schemas, built from @app/shared. */
import { z } from "zod";
import { aiFeedbackSchema } from "@app/shared";

export const generationIdParams = z.object({ generationId: z.uuid() });
export const feedbackBody = aiFeedbackSchema;
