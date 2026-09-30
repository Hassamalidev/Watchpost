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

const httpsUrl = z
  .url()
  .max(2_048)
  .refine((u) => u.startsWith("https://"), "must be an https:// URL");

/* Outbound webhook: we sign every request with the secret (generated when omitted). */
export const webhookChannelConfigSchema = z
  .object({
    url: z
      .url()
      .max(2_048)
      .refine((u) => /^https?:\/\//.test(u), "must be an http(s) URL"),
    secret: z.string().min(16).max(200).optional(),
  })
  .strict();
export type WebhookChannelConfig = z.infer<typeof webhookChannelConfigSchema>;

export const discordChannelConfigSchema = z
  .object({
    url: httpsUrl.refine(
      (u) =>
        /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(u),
      "must be a Discord webhook URL (https://discord.com/api/webhooks/…)",
    ),
  })
  .strict();
export type DiscordChannelConfig = z.infer<typeof discordChannelConfigSchema>;

/* Hosts that serve Teams "Workflows" webhook URLs (Power Automate / Logic Apps). */
export const TEAMS_WORKFLOW_HOST_SUFFIXES = [
  ".logic.azure.com",
  ".powerplatform.com",
  ".powerautomate.com",
] as const;

export const teamsChannelConfigSchema = z
  .object({
    url: httpsUrl.refine((u) => {
      const host = new URL(u).hostname;
      return TEAMS_WORKFLOW_HOST_SUFFIXES.some((s) => host.endsWith(s));
    }, "must be the URL of a Teams Workflows webhook"),
  })
  .strict();
export type TeamsChannelConfig = z.infer<typeof teamsChannelConfigSchema>;

export const slackChannelConfigSchema = z
  .object({
    installationId: z.uuid(),
    /* Slack conversation ID (C…, G…). */
    channelId: z.string().regex(/^[CGD][A-Z0-9]{2,}$/, "must be a Slack channel ID"),
    channelName: z.string().min(1).max(200),
  })
  .strict();
export type SlackChannelConfig = z.infer<typeof slackChannelConfigSchema>;

/* Telegram chats link through a deep link to our bot; the chat is unknown until then. */
export const telegramChannelConfigSchema = z
  .object({
    chatId: z.string().max(64).nullable().default(null),
    chatTitle: z.string().max(200).nullable().default(null),
  })
  .strict();
export type TelegramChannelConfig = z.infer<typeof telegramChannelConfigSchema>;

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
