import { z } from "zod";
import { API_ERROR_CODES } from "../constants/api-errors.js";

/* RFC 9457 problem details as returned by every API error. */
export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.enum(API_ERROR_CODES),
  detail: z.string().optional(),
  requestId: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

export type Problem = z.infer<typeof problemSchema>;
