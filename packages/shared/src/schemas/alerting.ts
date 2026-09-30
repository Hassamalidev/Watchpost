/*
 * Alert channels and alert policies (PRODUCT.md §6.4, §9.4). Each channel type has its own config
 * schema; types without one here arrive in later tasks (wave 1: P1-T13) and are refused until then.
 */
import { z } from "zod";

export const CHANNEL_TYPES = ["email", "slack", "teams", "discord", "telegram", "webhook"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const CHANNEL_STATUSES = ["healthy", "failing"] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

export const emailChannelConfigSchema = z
  .object({ to: z.array(z.email()).min(1).max(10) })
  .strict();
export type EmailChannelConfig = z.infer<typeof emailChannelConfigSchema>;

const channelName = z.string().trim().min(1).max(100);

export const createChannelSchema = z
  .object({
    type: z.enum(CHANNEL_TYPES),
    name: channelName,
    /* Validated by the channel type's adapter. */
    config: z.record(z.string(), z.unknown()),
  })
  .strict();
export type CreateChannelInput = z.infer<typeof createChannelSchema>;

export const updateChannelSchema = z
  .object({
    name: channelName.optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((b) => b.name !== undefined || b.config !== undefined, "nothing to update");

/* What an alert policy can notify about (§9.4). */
export const ALERT_EVENT_KINDS = [
  "triggered",
  "acknowledged",
  "resolved",
  "reminder",
  "flapping",
] as const;
export type AlertEventKind = (typeof ALERT_EVENT_KINDS)[number];

export const alertPolicyRulesSchema = z
  .object({
    channelIds: z.array(z.uuid()).max(50).default([]),
    events: z
      .object(
        Object.fromEntries(ALERT_EVENT_KINDS.map((k) => [k, z.boolean().default(true)])) as Record<
          AlertEventKind,
          z.ZodDefault<z.ZodBoolean>
        >,
      )
      .strict()
      .default({
        triggered: true,
        acknowledged: true,
        resolved: true,
        reminder: true,
        flapping: true,
      }),
  })
  .strict()
  .refine((r) => new Set(r.channelIds).size === r.channelIds.length, {
    message: "channels must not repeat",
    path: ["channelIds"],
  });
export type AlertPolicyRules = z.infer<typeof alertPolicyRulesSchema>;

export const alertPolicyBodySchema = z
  .object({ name: z.string().trim().min(1).max(100), rules: alertPolicyRulesSchema })
  .strict();
export type AlertPolicyInput = z.input<typeof alertPolicyBodySchema>;
