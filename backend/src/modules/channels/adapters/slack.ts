/*
 * Slack (PRODUCT.md §10): posts through the workspace's OAuth installation with Block Kit — a header
 * with the state, fields, and an "Open incident" button. Follow-ups reply in the thread of the first
 * message, and the first message is updated to the latest state. Buttons that act (acknowledge,
 * snooze, resolve) and user linking arrive in P4.
 */
import { slackChannelConfigSchema, type SlackChannelConfig } from "@app/shared";
import { ValidationError } from "../../../core/errors.js";
import type { OutboundHttp } from "../../../infra/http/outbound.js";
import {
  ChannelDeliveryError,
  type AlertEvent,
  type ChannelAdapter,
  type RenderedMessage,
} from "../types/adapter.js";
import { call, parseJson } from "./http.js";
import { renderPlain } from "./render.js";

export const SLACK_API = "https://slack.com/api";

/* Slack `error` values that retrying can't fix. */
const PERMANENT_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "no_permission",
  "missing_scope",
  "channel_not_found",
  "is_archived",
  "not_in_channel",
  "org_login_required",
  "team_access_not_granted",
  "ekm_access_denied",
  "invalid_blocks",
  "msg_too_long",
]);

const HEADER = {
  triggered: "🔴 DOWN",
  reminder: "🔴 STILL DOWN",
  flapping: "🟠 FLAPPING",
  acknowledged: "🟡 ACKNOWLEDGED",
  resolved: "✅ RESOLVED",
  test: "🧪 TEST",
} as const;

export function slackBlocks(event: AlertEvent, message: RenderedMessage): unknown[] {
  const { incident } = event;
  if (event.kind === "test") {
    return [
      { type: "header", text: { type: "plain_text", text: `${HEADER.test} · Watchpost` } },
      { type: "section", text: { type: "mrkdwn", text: message.text } },
    ];
  }
  const subject = incident.monitorName ?? incident.title;
  const since = Math.floor(Date.parse(incident.startedAt) / 1_000);
  const fields = [
    `*Incident*\n#${incident.number} ${incident.title}`,
    `*Severity*\n${incident.severity}`,
    ...(incident.causeCode ? [`*Cause*\n${incident.causeCode}`] : []),
    ...(incident.failingRegions.length > 0
      ? [`*Failing regions*\n${incident.failingRegions.join(", ")}`]
      : []),
    `*Since*\n<!date^${since}^{date_short_pretty} {time}|${incident.startedAt}>`,
    ...(event.actor ? [`*By*\n${event.actor}`] : []),
  ].map((text) => ({ type: "mrkdwn", text }));
  return [
    {
      type: "header",
      text: { type: "plain_text", text: `${HEADER[event.kind]} · ${subject}`.slice(0, 150) },
    },
    { type: "section", fields: fields.slice(0, 10) },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open incident" },
          url: incident.url,
          action_id: "open_incident",
        },
      ],
    },
  ];
}

export function createSlackAdapter(deps: {
  http: OutboundHttp;
  /* The decrypted bot token of an installation. */
  tokenFor: (installationId: string) => Promise<string | undefined>;
  /* True if the installation belongs to the workspace. */
  ownsInstallation: (installationId: string, workspaceId: string) => Promise<boolean>;
}): ChannelAdapter<SlackChannelConfig> {
  const parse = (input: unknown) => {
    const parsed = slackChannelConfigSchema.safeParse(input);
    if (!parsed.success)
      throw new ValidationError(`Invalid Slack channel: ${parsed.error.message}`);
    return parsed.data;
  };

  async function api(installationId: string, method: string, payload: object) {
    const token = await deps.tokenFor(installationId);
    if (token === undefined) {
      throw new ChannelDeliveryError("The Slack app was uninstalled from this workspace.", true);
    }
    const res = await call(
      deps.http,
      {
        method: "POST",
        url: `${SLACK_API}/${method}`,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(payload),
      },
      "Slack",
    );
    if (res.status === 429 || res.status >= 500) {
      throw new ChannelDeliveryError(`Slack answered HTTP ${res.status}`);
    }
    const body = parseJson(res.body) as { ok?: boolean; error?: string; ts?: string } | undefined;
    if (body?.ok !== true) {
      const error = body?.error ?? `HTTP ${res.status}`;
      throw new ChannelDeliveryError(
        `Slack refused the message: ${error}`,
        PERMANENT_ERRORS.has(error),
      );
    }
    return body;
  }

  return {
    type: "slack",
    parseConfig: parse,
    async prepare(input, ctx) {
      const config = parse(input);
      if (!(await deps.ownsInstallation(config.installationId, ctx.workspaceId))) {
        throw new ValidationError("That Slack installation doesn't belong to this workspace.");
      }
      return config;
    },
    render(event) {
      const plain = renderPlain(event);
      return { ...plain, body: slackBlocks(event, plain) };
    },
    async send(config, message, meta) {
      const threadTs = meta.threadRef?.split(":")[1];
      const sent = await api(config.installationId, "chat.postMessage", {
        channel: config.channelId,
        text: message.title,
        blocks: message.body,
        unfurl_links: false,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      return { providerRef: sent.ts ? `${config.channelId}:${sent.ts}` : undefined };
    },
    async update(config, ref, message) {
      const [channel, ts] = ref.split(":");
      await api(config.installationId, "chat.update", {
        channel,
        ts,
        text: message.title,
        blocks: message.body,
      });
    },
  };
}
