/* Zod request schemas for badges. */
import { z } from "zod";
import { BADGE_KINDS, BADGE_UPTIME_DAYS } from "../badges.service.js";

export const monitorIdParams = z.object({ monitorId: z.uuid() });

/* `/api/public/badges/<monitorId>.<signature>/<kind>.svg` */
export const badgeParams = z.object({
  token: z.string().min(40).max(80),
  file: z
    .string()
    .regex(new RegExp(`^(${BADGE_KINDS.join("|")})\\.svg$`), "unknown badge")
    .transform((file) => file.slice(0, -4) as (typeof BADGE_KINDS)[number]),
});

export const badgeQuery = z.object({
  /* Plain words only: the label ends up inside an image other sites embed. */
  label: z
    .string()
    .trim()
    .min(1)
    .max(30)
    .regex(/^[\p{L}\p{N} ._%+-]+$/u, "letters, digits, spaces and . _ % + - only")
    .optional(),
  days: z.coerce
    .number()
    .refine((n): n is (typeof BADGE_UPTIME_DAYS)[number] =>
      (BADGE_UPTIME_DAYS as readonly number[]).includes(n),
    )
    .optional(),
});
