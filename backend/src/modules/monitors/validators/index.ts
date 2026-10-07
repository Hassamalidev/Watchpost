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

/*
 * A settings PATCH keeps only the keys the caller sent. (`.partial()` still fills in defaults for
 * missing keys, which would silently reset regions, tags and policies on every edit.)
 */
const settingsPatchSchema = monitorSettingsObject.partial().strict();
/* Links to other things, which a PATCH can remove by sending null. */
const CLEARABLE = ["groupId", "parentId", "alertPolicyId"] as const;
const settingsPatch = z.record(z.string(), z.unknown()).transform((input, ctx) => {
  const cleared = CLEARABLE.filter((key) => input[key] === null);
  const raw = Object.fromEntries(
    Object.entries(input).filter(([key]) => !(cleared as string[]).includes(key)),
  );
  const parsed = settingsPatchSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
    }
    return z.NEVER;
  }
  return {
    ...Object.fromEntries(Object.entries(parsed.data).filter(([key]) => Object.hasOwn(raw, key))),
    /* An explicit undefined overrides the stored value when the service merges the patch. */
    ...Object.fromEntries(cleared.map((key) => [key, undefined])),
  } as Partial<z.output<typeof settingsPatchSchema>>;
});

/* Partial settings are merged with the stored ones and then validated as a whole by the service. */
export const updateMonitorBody = z
  .object({
    settings: settingsPatch.optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((b) => b.settings !== undefined || b.config !== undefined, "nothing to update");

export const groupBody = z
  .object({ name: z.string().trim().min(1).max(100), groupAlerts: z.boolean().optional() })
  .strict();
