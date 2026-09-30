/* Zod request schemas for the monitors API, built from @app/shared. */
import { z } from "zod";
import { MONITOR_TYPES, createMonitorSchema, monitorSettingsObject } from "@app/shared";

export const monitorIdParams = z.object({ monitorId: z.uuid() });
export const groupIdParams = z.object({ groupId: z.uuid() });

export const listMonitorsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
  tag: z.string().min(1).max(64).optional(),
  groupId: z.uuid().optional(),
  type: z.enum(MONITOR_TYPES).optional(),
  paused: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  q: z.string().trim().min(1).max(200).optional(),
});

export const createMonitorBody = createMonitorSchema;

/* Partial settings are merged with the stored ones and then validated as a whole by the service. */
export const updateMonitorBody = z
  .object({
    settings: monitorSettingsObject.partial().strict().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((b) => b.settings !== undefined || b.config !== undefined, "nothing to update");

export const groupBody = z.object({ name: z.string().trim().min(1).max(100) }).strict();
