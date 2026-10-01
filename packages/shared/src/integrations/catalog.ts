/*
 * The integration catalog (PRODUCT.md §6.4, §10): one description of every alert channel, shared by
 * the API (which fields are secrets, what a channel can do) and the web app (the gallery and its
 * setup forms). Adding a channel means a config schema, an adapter and an entry here; the forms,
 * secret handling and docs links follow from it.
 */
import type { ChannelType } from "../schemas/alerting.js";
import {
  NTFY_DEFAULT_SERVER,
  OPSGENIE_REGIONS,
  PUSHOVER_CRITICAL_MODES,
  SERVICE_REGIONS,
} from "../schemas/channel-configs.js";

export const INTEGRATION_CATEGORIES = ["chat", "oncall", "push", "email", "automation"] as const;
export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number];

export type ChannelFieldKind = "url" | "secret" | "text" | "emails" | "select" | "headers";

export interface ChannelField {
  /* The key in the channel's config. */
  key: string;
  kind: ChannelFieldKind;
  required: boolean;
  /*
   * Write-only: the API never returns the value (it answers SECRET_MASK, or the origin for a URL)
   * and keeps the stored one when the field comes back empty or unchanged.
   */
  secret?: true;
  /* For `select`. */
  options?: readonly string[];
  defaultValue?: string;
  placeholder?: string;
}

/*
 * What happens to an incident's later events (acknowledged, resolved, reminders):
 * `thread` replies under the first message, `update` rewrites it, `sync` changes the state of the
 * same alert in the other tool, `separate` sends a new message each time.
 */
export type FollowUpStyle = "thread" | "update" | "sync" | "separate";

export interface ChannelCapabilities {
  followUps: FollowUpStyle;
  /* "Send test" reaches whoever is on call in the other tool, so the app asks first. */
  testPages: boolean;
  /* How the channel is connected: a form, Slack's OAuth install, or a Telegram deep link. */
  setup: "form" | "oauth" | "link";
}

const url = (key: string, placeholder: string, secret = true): ChannelField => ({
  key,
  kind: "url",
  required: true,
  placeholder,
  ...(secret ? { secret: true as const } : {}),
});
const secret = (key: string, required = true): ChannelField => ({
  key,
  kind: "secret",
  required,
  secret: true,
});

export const CHANNEL_FIELDS: Record<ChannelType, readonly ChannelField[]> = {
  email: [{ key: "to", kind: "emails", required: true, placeholder: "oncall@example.com" }],
  slack: [],
  telegram: [],
  teams: [url("url", "https://….environment.api.powerplatform.com/…")],
  discord: [url("url", "https://discord.com/api/webhooks/…")],
  webhook: [
    url("url", "https://example.com/hooks/watchpost", false),
    { key: "headers", kind: "headers", required: false, placeholder: "Authorization: Bearer …" },
  ],
  slack_webhook: [url("url", "https://hooks.slack.com/services/T…/B…/…")],
  google_chat: [url("url", "https://chat.googleapis.com/v1/spaces/…/messages?key=…&token=…")],
  mattermost: [url("url", "https://mattermost.example.com/hooks/…")],
  rocketchat: [url("url", "https://chat.example.com/hooks/…/…")],
  zulip: [
    url("serverUrl", "https://example.zulipchat.com", false),
    {
      key: "botEmail",
      kind: "text",
      required: true,
      placeholder: "watchpost-bot@example.zulipchat.com",
    },
    secret("apiKey"),
    { key: "stream", kind: "text", required: true, placeholder: "alerts" },
    { key: "topic", kind: "text", required: false },
  ],
  matrix: [
    url("homeserverUrl", "https://matrix.example.org", false),
    secret("accessToken"),
    { key: "roomId", kind: "text", required: true, placeholder: "!abcdef:example.org" },
  ],
  pagerduty: [
    secret("routingKey"),
    { key: "region", kind: "select", required: true, options: SERVICE_REGIONS, defaultValue: "us" },
  ],
  opsgenie: [
    secret("apiKey"),
    {
      key: "region",
      kind: "select",
      required: true,
      options: OPSGENIE_REGIONS,
      defaultValue: "us",
    },
  ],
  splunk_oncall: [
    url("url", "https://alert.victorops.com/integrations/generic/20131114/alert/…/…"),
  ],
  pushover: [
    secret("userKey"),
    secret("appToken"),
    {
      key: "critical",
      kind: "select",
      required: true,
      options: PUSHOVER_CRITICAL_MODES,
      defaultValue: "high",
    },
  ],
  pushbullet: [secret("accessToken"), { key: "channelTag", kind: "text", required: false }],
  ntfy: [
    { ...url("serverUrl", NTFY_DEFAULT_SERVER, false), defaultValue: NTFY_DEFAULT_SERVER },
    { key: "topic", kind: "text", required: true, placeholder: "acme-alerts-8f3k2" },
    secret("accessToken", false),
  ],
  gotify: [url("serverUrl", "https://gotify.example.com", false), secret("appToken")],
};

const caps = (
  followUps: FollowUpStyle,
  extra: Partial<Omit<ChannelCapabilities, "followUps">> = {},
): ChannelCapabilities => ({ followUps, testPages: false, setup: "form", ...extra });

export const CHANNEL_CAPABILITIES: Record<ChannelType, ChannelCapabilities> = {
  email: caps("separate"),
  slack: caps("thread", { setup: "oauth" }),
  telegram: caps("thread", { setup: "link" }),
  teams: caps("separate"),
  discord: caps("update"),
  webhook: caps("separate"),
  slack_webhook: caps("separate"),
  google_chat: caps("thread"),
  mattermost: caps("separate"),
  rocketchat: caps("separate"),
  zulip: caps("thread"),
  matrix: caps("thread"),
  pagerduty: caps("sync", { testPages: true }),
  opsgenie: caps("sync", { testPages: true }),
  splunk_oncall: caps("sync"),
  pushover: caps("separate"),
  pushbullet: caps("separate"),
  ntfy: caps("update"),
  gotify: caps("separate"),
};

/* Product names as their makers write them; used in emails, logs and the app. */
export const CHANNEL_LABELS: Record<ChannelType, string> = {
  email: "Email",
  slack: "Slack",
  telegram: "Telegram",
  teams: "Microsoft Teams",
  discord: "Discord",
  webhook: "Webhook",
  slack_webhook: "Slack (incoming webhook)",
  google_chat: "Google Chat",
  mattermost: "Mattermost",
  rocketchat: "Rocket.Chat",
  zulip: "Zulip",
  matrix: "Matrix",
  pagerduty: "PagerDuty",
  opsgenie: "Opsgenie",
  splunk_oncall: "Splunk On-Call",
  pushover: "Pushover",
  pushbullet: "Pushbullet",
  ntfy: "ntfy",
  gotify: "Gotify",
};

/* Stable IDs: the gallery URL (`/integrations/new/<id>`), the docs file and the copy's key. */
export const INTEGRATION_IDS = [
  "slack",
  "slack-webhook",
  "teams",
  "discord",
  "telegram",
  "google-chat",
  "mattermost",
  "rocketchat",
  "zulip",
  "matrix",
  "pagerduty",
  "opsgenie",
  "jira-service-management",
  "splunk-on-call",
  "pushover",
  "ntfy",
  "pushbullet",
  "gotify",
  "email",
  "webhook",
  "zapier",
  "make",
  "n8n",
] as const;
export type IntegrationId = (typeof INTEGRATION_IDS)[number];

export interface IntegrationDefinition {
  id: IntegrationId;
  name: string;
  /* The channel type it creates; several entries can share one (Zapier is a webhook). */
  type: ChannelType;
  category: IntegrationCategory;
  /* Config values this entry fixes; their fields are not shown. */
  preset?: Readonly<Record<string, string>>;
  /* What people type when they look for it, besides the name. */
  keywords: readonly string[];
}

const entry = (
  id: IntegrationId,
  type: ChannelType,
  category: IntegrationCategory,
  keywords: readonly string[] = [],
  extra: Partial<Pick<IntegrationDefinition, "name" | "preset">> = {},
): IntegrationDefinition => ({
  id,
  name: extra.name ?? CHANNEL_LABELS[type],
  type,
  category,
  keywords,
  ...(extra.preset ? { preset: extra.preset } : {}),
});

/* In gallery order: the most used first within each category. */
export const INTEGRATIONS: readonly IntegrationDefinition[] = [
  entry("slack", "slack", "chat", ["chat", "app", "oauth"]),
  entry("slack-webhook", "slack_webhook", "chat", ["slack", "incoming webhook", "hook"]),
  entry("teams", "teams", "chat", ["microsoft", "ms teams", "workflows", "office"]),
  entry("discord", "discord", "chat", ["webhook"]),
  entry("telegram", "telegram", "chat", ["bot", "messenger"]),
  entry("google-chat", "google_chat", "chat", ["gchat", "hangouts", "workspace", "spaces"]),
  entry("mattermost", "mattermost", "chat", ["self-hosted", "webhook"]),
  entry("rocketchat", "rocketchat", "chat", ["rocket", "self-hosted", "webhook"]),
  entry("zulip", "zulip", "chat", ["stream", "topic", "bot"]),
  entry("matrix", "matrix", "chat", ["element", "synapse", "room"]),
  entry("pagerduty", "pagerduty", "oncall", ["pager", "on-call", "events api", "incident"]),
  entry("opsgenie", "opsgenie", "oncall", ["atlassian", "on-call", "genie"]),
  entry("jira-service-management", "opsgenie", "oncall", ["jsm", "atlassian", "opsgenie", "ops"], {
    name: "Jira Service Management",
    preset: { region: "jsm" },
  }),
  entry("splunk-on-call", "splunk_oncall", "oncall", ["victorops", "on-call", "splunk"]),
  entry("pushover", "pushover", "push", ["phone", "mobile", "notification"]),
  entry("ntfy", "ntfy", "push", ["phone", "mobile", "notification", "self-hosted"]),
  entry("pushbullet", "pushbullet", "push", ["phone", "mobile", "notification"]),
  entry("gotify", "gotify", "push", ["phone", "android", "self-hosted", "notification"]),
  entry("email", "email", "email", ["mail", "inbox", "smtp"]),
  entry("webhook", "webhook", "automation", ["http", "api", "json", "custom", "signed"]),
  entry("zapier", "webhook", "automation", ["zap", "automation", "no-code"], { name: "Zapier" }),
  entry("make", "webhook", "automation", ["integromat", "automation", "scenario", "no-code"], {
    name: "Make",
  }),
  entry("n8n", "webhook", "automation", ["automation", "workflow", "self-hosted"], {
    name: "n8n",
  }),
];

export function findIntegration(id: string): IntegrationDefinition | undefined {
  return INTEGRATIONS.find((i) => i.id === id);
}

/* The gallery entry a channel is shown as: the one for its type whose preset matches its config. */
export function integrationForChannel(
  type: ChannelType,
  config: Readonly<Record<string, unknown>> = {},
): IntegrationDefinition {
  const ofType = INTEGRATIONS.filter((i) => i.type === type);
  const preset = ofType.find(
    (i) => i.preset !== undefined && Object.entries(i.preset).every(([k, v]) => config[k] === v),
  );
  const plain = ofType.find((i) => i.preset === undefined);
  /* Every type has an entry without a preset; a test asserts it. */
  return preset ?? plain ?? (ofType[0] as IntegrationDefinition);
}

/* The fields an entry's form shows: the type's fields minus those its preset fixes. */
export function integrationFields(integration: IntegrationDefinition): readonly ChannelField[] {
  const fixed = integration.preset ?? {};
  return CHANNEL_FIELDS[integration.type].filter((f) => !(f.key in fixed));
}
