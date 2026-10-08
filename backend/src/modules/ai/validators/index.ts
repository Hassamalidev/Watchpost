/* Zod request schemas, built from @app/shared. */
import { z } from "zod";
import { aiFeedbackSchema } from "@app/shared";

export const generationIdParams = z.object({ generationId: z.uuid() });
export const feedbackBody = aiFeedbackSchema;
/* An incident by its ID or its per-workspace number, as the incidents API takes it. */
export const incidentRefParams = z.object({
  incidentRef: z.union([
    z.uuid(),
    z
      .string()
      .regex(/^[1-9][0-9]{0,8}$/)
      .transform(Number),
  ]),
});
