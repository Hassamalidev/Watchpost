/*
 * Config schemas for the URL- and token-based channels (PRODUCT.md §6.4, §10): chat webhooks, on-call
 * tools and push services. Each provider's URL or key shape is checked here, so a value pasted into
 * the wrong integration is refused with a message that says what was expected.
 */
import { z } from "zod";

/* What the API returns in place of a stored secret; sending it back keeps the stored value. */
export const SECRET_MASK = "********";

export const httpsUrl = z
  .url()
  .max(2_048)
  .refine((u) => u.startsWith("https://"), "must be an https:// URL");

/* The address of a self-hosted server (https://chat.example.com or …/subpath), without a query. */
const serverUrl = httpsUrl.refine((u) => {
  const url = new URL(u);
  return url.search === "" && url.hash === "" && url.username === "" && url.password === "";
}, "must be the server address only, without a query string or credentials");

const token = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    /* Tokens travel in HTTP headers: printable ASCII only, so a pasted ellipsis is caught here. */
    .regex(/^[\x21-\x7e]+$/, "must not contain spaces or special characters");

/* Slack incoming webhook: posts to the one channel picked when the webhook was created. */
export const slackWebhookChannelConfigSchema = z
  .object({
    url: httpsUrl.refine(
      (u) =>
        /^https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+$/.test(u),
      "must be a Slack incoming webhook URL (https://hooks.slack.com/services/T…/B…/…)",
    ),
  })
  .strict();
export type SlackWebhookChannelConfig = z.infer<typeof slackWebhookChannelConfigSchema>;

export const googleChatChannelConfigSchema = z
  .object({
    url: httpsUrl.refine((u) => {
      const url = new URL(u);
      return (
        url.hostname === "chat.googleapis.com" &&
        /^\/v1\/spaces\/[^/]+\/messages$/.test(url.pathname) &&
        url.searchParams.has("key") &&
        url.searchParams.has("token")
      );
    }, "must be a Google Chat webhook URL (https://chat.googleapis.com/v1/spaces/…/messages?key=…&token=…)"),
  })
  .strict();
export type GoogleChatChannelConfig = z.infer<typeof googleChatChannelConfigSchema>;

export const mattermostChannelConfigSchema = z
  .object({
    url: httpsUrl.refine(
      (u) => /\/hooks\/[A-Za-z0-9]+$/.test(new URL(u).pathname) && new URL(u).search === "",
      "must be a Mattermost incoming webhook URL (https://your-server/hooks/…)",
    ),
  })
  .strict();
export type MattermostChannelConfig = z.infer<typeof mattermostChannelConfigSchema>;

export const rocketChatChannelConfigSchema = z
  .object({
    url: httpsUrl.refine(
      (u) => /\/hooks\/[^/]+\/[^/]+$/.test(new URL(u).pathname) && new URL(u).search === "",
      "must be a Rocket.Chat incoming webhook URL (https://your-server/hooks/<id>/<token>)",
    ),
  })
  .strict();
export type RocketChatChannelConfig = z.infer<typeof rocketChatChannelConfigSchema>;

export const zulipChannelConfigSchema = z
  .object({
    serverUrl,
    botEmail: z.email().max(254),
    apiKey: token(16, 128),
    /* The channel (stream) to post to. */
    stream: z.string().trim().min(1).max(60),
    /* Empty: one topic per monitor, so each monitor's alerts form their own thread. */
    topic: z.string().trim().max(60).optional(),
  })
  .strict();
export type ZulipChannelConfig = z.infer<typeof zulipChannelConfigSchema>;

export const matrixChannelConfigSchema = z
  .object({
    homeserverUrl: serverUrl,
    accessToken: token(8, 2_048),
    /* An internal room ID (!abc:example.org); newer room versions have no server part. */
    roomId: z
      .string()
      .trim()
      .max(255)
      .regex(/^![^\s:]+(:\S+)?$/, "must be a room ID starting with ! (not a #alias)"),
  })
  .strict();
export type MatrixChannelConfig = z.infer<typeof matrixChannelConfigSchema>;

export const SERVICE_REGIONS = ["us", "eu"] as const;
export type ServiceRegion = (typeof SERVICE_REGIONS)[number];

export const pagerDutyChannelConfigSchema = z
  .object({
    /* The integration key of an "Events API v2" integration on a PagerDuty service. */
    routingKey: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{32}$/, "must be the 32-character integration key"),
    region: z.enum(SERVICE_REGIONS).default("us"),
  })
  .strict();
export type PagerDutyChannelConfig = z.infer<typeof pagerDutyChannelConfigSchema>;

/* Opsgenie's two regions, and Jira Service Management, which took over its alert API. */
export const OPSGENIE_REGIONS = ["us", "eu", "jsm"] as const;
export type OpsgenieRegion = (typeof OPSGENIE_REGIONS)[number];

export const opsgenieChannelConfigSchema = z
  .object({
    /* The API key of an "API" integration on a team (Opsgenie or Jira Service Management). */
    apiKey: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{36}$/, "must be the integration's 36-character API key"),
    region: z.enum(OPSGENIE_REGIONS).default("us"),
  })
  .strict();
export type OpsgenieChannelConfig = z.infer<typeof opsgenieChannelConfigSchema>;

/* Splunk On-Call (VictorOps) REST endpoint: the URL holds the API key and the routing key. */
export const splunkOnCallChannelConfigSchema = z
  .object({
    url: httpsUrl
      .refine(
        (u) => !/\$routing_key|%24routing_key/i.test(u),
        "replace $routing_key at the end of the URL with one of your routing keys",
      )
      .refine(
        (u) =>
          /^https:\/\/alert\.victorops\.com\/integrations\/generic\/\d+\/alert\/[A-Za-z0-9-]+\/[^/?#\s]+$/.test(
            u,
          ),
        "must be a REST endpoint URL (https://alert.victorops.com/integrations/generic/…/alert/<key>/<routing key>)",
      ),
  })
  .strict();
export type SplunkOnCallChannelConfig = z.infer<typeof splunkOnCallChannelConfigSchema>;

const pushoverKey = (what: string) =>
  z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{30}$/, `must be the 30-character ${what}`);

export const PUSHOVER_CRITICAL_MODES = ["high", "emergency"] as const;

export const pushoverChannelConfigSchema = z
  .object({
    userKey: pushoverKey("user or group key"),
    appToken: pushoverKey("application API token"),
    /*
     * How critical incidents arrive: `high` bypasses quiet hours; `emergency` repeats every minute
     * for up to an hour until someone acknowledges it in Pushover or the incident is acknowledged.
     */
    critical: z.enum(PUSHOVER_CRITICAL_MODES).default("high"),
  })
  .strict();
export type PushoverChannelConfig = z.infer<typeof pushoverChannelConfigSchema>;

export const pushbulletChannelConfigSchema = z
  .object({
    accessToken: token(20, 128),
    /* Push to a Pushbullet channel's subscribers instead of the token owner's devices. */
    channelTag: z
      .string()
      .trim()
      .max(64)
      .regex(/^[A-Za-z0-9_-]*$/, "may contain letters, numbers, - and _")
      .optional(),
  })
  .strict();
export type PushbulletChannelConfig = z.infer<typeof pushbulletChannelConfigSchema>;

export const NTFY_DEFAULT_SERVER = "https://ntfy.sh";

export const ntfyChannelConfigSchema = z
  .object({
    serverUrl: serverUrl
      .refine(
        (u) => new URL(u).hostname !== "ntfy.sh" || new URL(u).pathname === "/",
        "must be the server address only; the topic goes in its own field",
      )
      .default(NTFY_DEFAULT_SERVER),
    topic: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,64}$/, "may contain letters, numbers, - and _ (up to 64)"),
    /* Needed only for protected topics. */
    accessToken: token(8, 256).optional(),
  })
  .strict();
export type NtfyChannelConfig = z.infer<typeof ntfyChannelConfigSchema>;

export const gotifyChannelConfigSchema = z
  .object({
    serverUrl,
    appToken: token(8, 128),
  })
  .strict();
export type GotifyChannelConfig = z.infer<typeof gotifyChannelConfigSchema>;

/*
 * Home Assistant: a webhook trigger of an automation. Whoever knows the webhook ID can fire it, so
 * the ID is kept like a secret.
 */
export const homeAssistantChannelConfigSchema = z
  .object({
    serverUrl,
    webhookId: token(8, 200),
  })
  .strict();
export type HomeAssistantChannelConfig = z.infer<typeof homeAssistantChannelConfigSchema>;

/* A phone number in international format: + and 8 to 15 digits, no spaces. */
export const phoneNumberSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s().-]/g, ""))
  .pipe(
    z.string().regex(/^\+[1-9]\d{7,14}$/, "must be in international format, like +14155550123"),
  );

/* SMS and voice share one shape: the verified number alerts go to. */
export const phoneChannelConfigSchema = z.object({ phone: phoneNumberSchema }).strict();
export type PhoneChannelConfig = z.infer<typeof phoneChannelConfigSchema>;

/* What a phone number costs to alert, shown before it is enabled (PRODUCT.md §5). */
export interface PhoneCost {
  phone: string;
  /* ISO 3166-1 alpha-2. */
  country: string;
  /* Alert credits per SMS and per voice call. */
  smsCredits: number;
  voiceCredits: number;
}

export const phoneVerificationSchema = z.object({ phone: phoneNumberSchema }).strict();
export const phoneConfirmationSchema = z
  .object({
    phone: phoneNumberSchema,
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, "is 6 digits"),
  })
  .strict();

/* Extra request headers for outbound webhooks (an Authorization header, a routing header). */
const RESERVED_HEADERS =
  /^(host|content-length|content-type|connection|transfer-encoding|user-agent)$/i;

export const webhookHeadersSchema = z
  .record(
    z
      .string()
      .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/, "is not a valid header name")
      .refine((name) => !RESERVED_HEADERS.test(name), "is set by Watchpost and can't be replaced")
      .refine(
        (name) => !name.toLowerCase().startsWith("watchpost-"),
        "Watchpost-* headers are reserved",
      ),
    z
      .string()
      .min(1)
      .max(1_024)
      .regex(/^[\t\x20-\x7e]+$/, "may contain printable ASCII only"),
  )
  .refine((headers) => Object.keys(headers).length <= 10, "at most 10 headers");
export type WebhookHeaders = z.infer<typeof webhookHeadersSchema>;
