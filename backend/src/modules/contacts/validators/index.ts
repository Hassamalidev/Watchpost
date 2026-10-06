/* Zod request schemas, built from @app/shared. */
import {
  URGENCIES,
  contactCodeSchema,
  createContactMethodSchema,
  replaceRulesSchema,
} from "@app/shared";
import { z } from "zod";

export const createMethodBody = createContactMethodSchema;
export const confirmBody = contactCodeSchema;
export const replaceRulesBody = replaceRulesSchema;
export const methodIdParams = z.object({ methodId: z.uuid() });
export const urgencyParams = z.object({ urgency: z.enum(URGENCIES) });
