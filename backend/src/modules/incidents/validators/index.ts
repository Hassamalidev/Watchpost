/* Zod request schemas for the incidents API, built from @app/shared. */
import { z } from "zod";
import { savePostmortemSchema, SEVERITIES } from "@app/shared";

/* An incident is addressed by its ID or by its per-workspace number (#482). */
export const incidentRefParams = z.object({
  incidentRef: z.union([
    z.uuid(),
    z
      .string()
      .regex(/^[1-9]\d{0,8}$/)
      .transform(Number),
  ]),
});

export const listIncidentsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
  status: z.enum(["open", "triggered", "acknowledged", "snoozed", "resolved"]).optional(),
  monitorId: z.uuid().optional(),
  severity: z.enum(SEVERITIES).optional(),
});

export const createIncidentBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    severity: z.enum(SEVERITIES).default("high"),
    monitorId: z.uuid().optional(),
    note: z.string().trim().min(1).max(10_000).optional(),
  })
  .strict();

export const summaryQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

export const tuningParams = z.object({ monitorId: z.uuid() });

export const postmortemBody = savePostmortemSchema;
export const commentBody = z.object({ body: z.string().trim().min(1).max(10_000) }).strict();

export const falseAlarmBody = z.object({ falseAlarm: z.boolean() }).strict();
