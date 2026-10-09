/* Zod request schemas for the audit log. */
import { z } from "zod";
import { AUDIT_CATEGORIES } from "@app/shared";

export const auditListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
  category: z.enum(AUDIT_CATEGORIES).optional(),
});
export const auditExportQuery = z.object({
  days: z.coerce.number().int().min(1).max(400).default(90),
});
