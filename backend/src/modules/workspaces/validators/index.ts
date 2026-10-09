/* Zod request schemas for the workspaces API. */
import { z } from "zod";

function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value.includes("/") || value === "UTC";
  } catch {
    return false;
  }
}

export const createClientBody = z.object({ name: z.string().trim().min(2).max(80) }).strict();

export const updateSettingsBody = z
  .object({
    timezone: z
      .string()
      .refine(isIanaTimeZone, "must be an IANA time zone such as Europe/Berlin or Asia/Karachi")
      .optional(),
    requireTwoFactor: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, "nothing to update");

export type UpdateSettingsBody = z.infer<typeof updateSettingsBody>;
