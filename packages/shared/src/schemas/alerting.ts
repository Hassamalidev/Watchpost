/*
 * Alert channels and alert policies (PRODUCT.md §6.4, §9.4). Each channel type has its own config
 * schema; types without one here arrive in later tasks (wave 1: P1-T13) and are refused until then.
 */
import { z } from "zod";
import { SEVERITIES, type Severity } from "../constants/regions.js";
import { httpsUrl, webhookHeadersSchema } from "./channel-configs.js";

/* Wave 1 (P1-T13) first; the URL- and token-based channels of wave 2 (P1-T29) after it. */
export const CHANNEL_TYPES = [
  "email",
  "slack",
  "teams",
  "discord",
  "telegram",
  "webhook",
  "slack_webhook",
  "google_chat",
  "mattermost",
  "rocketchat",
  "zulip",
  "matrix",
  "pagerduty",
  "opsgenie",
  "splunk_oncall",
  "pushover",
  "pushbullet",
  "ntfy",
  "gotify",
  /* Paid, through the messaging provider (P3-T05): each message costs alert credits. */
  "sms",
  "voice",
] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const CHANNEL_STATUSES = ["healthy", "failing"] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

export const emailChannelConfigSchema = z
  .object({ to: z.array(z.email()).min(1).max(10) })
  .strict();
export type EmailChannelConfig = z.infer<typeof emailChannelConfigSchema>;

/* Outbound webhook: we sign every request with the secret (generated when omitted). */
export const webhookChannelConfigSchema = z
  .object({
    url: z
      .url()
      .max(2_048)
      .refine((u) => /^https?:\/\//.test(u), "must be an http(s) URL"),
    secret: z.string().min(16).max(200).optional(),
    /* Sent with every request, for endpoints that want an Authorization or routing header. */
    headers: webhookHeadersSchema.optional(),
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

/*
 * Hosts that serve Teams "Workflows" webhook URLs: Power Automate (`*.api.powerplatform.com`), the
 * older Logic Apps hosts, and Microsoft's sovereign clouds (US government, China).
 */
export const TEAMS_WORKFLOW_HOST_SUFFIXES = [
  ".logic.azure.com",
  ".powerplatform.com",
  ".powerautomate.com",
  ".powerplatform.microsoft.us",
  ".appsplatform.us",
  ".logic.azure.us",
  ".powerplatform.partner.microsoftonline.cn",
  ".logic.azure.cn",
] as const;

/* Office 365 connector webhooks: Microsoft switched them off in May 2026. */
const isRetiredTeamsConnector = (u: string) => {
  const host = new URL(u).hostname;
  return host.endsWith(".webhook.office.com") || host === "outlook.office.com";
};

export const teamsChannelConfigSchema = z
  .object({
    url: httpsUrl
      .refine(
        (u) => !isRetiredTeamsConnector(u),
        "is an Office 365 connector URL, which Microsoft retired in May 2026; create a Workflows webhook instead",
      )
      .refine(
        (u) =>
          isRetiredTeamsConnector(u) ||
          TEAMS_WORKFLOW_HOST_SUFFIXES.some((s) => new URL(u).hostname.endsWith(s)),
        "must be the URL of a Teams Workflows webhook",
      ),
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

/* What an alert policy can notify about (§9.4). */
export const ALERT_EVENT_KINDS = [
  "triggered",
  "acknowledged",
  "resolved",
  "reminder",
  "flapping",
] as const;
export type AlertEventKind = (typeof ALERT_EVENT_KINDS)[number];

const alertEventsSchema = z
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
  });

/*
 * What one channel wants to hear about (§6.4): which events, and from which severity up. A pager
 * can take only high and critical incidents while chat gets everything. The alert policy decides
 * which channels are asked; these rules decide what each of them accepts.
 */
export const channelRulesSchema = z
  .object({
    events: alertEventsSchema,
    minSeverity: z.enum(SEVERITIES).default("low"),
  })
  .strict();
export type ChannelRules = z.infer<typeof channelRulesSchema>;

/*
 * A change to a channel's rules: only what is sent changes. No defaults here, or a PATCH with just
 * `minSeverity` would quietly switch every event back on (the D-052 class of bug).
 */
export const channelRulesPatchSchema = z
  .object({
    events: z
      .object(
        Object.fromEntries(ALERT_EVENT_KINDS.map((k) => [k, z.boolean().optional()])) as Record<
          AlertEventKind,
          z.ZodOptional<z.ZodBoolean>
        >,
      )
      .strict()
      .optional(),
    minSeverity: z.enum(SEVERITIES).optional(),
  })
  .strict();
export type ChannelRulesPatch = z.infer<typeof channelRulesPatchSchema>;

export function mergeChannelRules(current: ChannelRules, patch: ChannelRulesPatch): ChannelRules {
  const events = { ...current.events };
  for (const kind of ALERT_EVENT_KINDS) {
    const value = patch.events?.[kind];
    if (value !== undefined) events[kind] = value;
  }
  return { events, minSeverity: patch.minSeverity ?? current.minSeverity };
}

const SEVERITY_RANK: Record<Severity, number> = { low: 0, high: 1, critical: 2 };

/* Events that close an alert in a tool that mirrors the incident's state (PagerDuty, Opsgenie). */
export const STATE_SYNC_EVENTS: readonly AlertEventKind[] = ["acknowledged", "resolved"];

/*
 * True if a channel with these rules should get this event of an incident with this severity.
 * `syncsState` channels always get acknowledgements and recoveries for incidents they were told
 * about: switching those off would leave the alert open in the other tool forever.
 */
export function channelAccepts(
  rules: ChannelRules,
  kind: AlertEventKind,
  severity: Severity,
  syncsState = false,
): boolean {
  if (SEVERITY_RANK[severity] < SEVERITY_RANK[rules.minSeverity]) return false;
  if (syncsState && STATE_SYNC_EVENTS.includes(kind)) return rules.events.triggered;
  return rules.events[kind];
}

const channelName = z.string().trim().min(1).max(100);

export const createChannelSchema = z
  .object({
    type: z.enum(CHANNEL_TYPES),
    name: channelName,
    /* Validated by the channel type's adapter. */
    config: z.record(z.string(), z.unknown()),
    rules: channelRulesSchema.optional(),
  })
  .strict();
export type CreateChannelInput = z.infer<typeof createChannelSchema>;

export const updateChannelSchema = z
  .object({
    name: channelName.optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    rules: channelRulesPatchSchema.optional(),
  })
  .strict()
  .refine(
    (b) => b.name !== undefined || b.config !== undefined || b.rules !== undefined,
    "nothing to update",
  );

export const alertPolicyRulesSchema = z
  .object({
    channelIds: z.array(z.uuid()).max(50).default([]),
    events: alertEventsSchema,
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
