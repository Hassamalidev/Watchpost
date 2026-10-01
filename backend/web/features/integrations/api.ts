/* Typed calls for alert channels, the default alert policy, "Send test" and chat app setup. */
import type { ChannelRules, ChannelType, IntegrationId, PhoneCost } from "@app/shared";
import { api, wsPath } from "@/lib/api";

export interface Channel {
  id: string;
  type: ChannelType;
  name: string;
  status: "healthy" | "failing";
  /* The gallery entry it shows as. */
  integration: IntegrationId;
  /* Which events and severities the channel accepts. */
  rules: ChannelRules;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
}

/* Admins only. Secrets come back masked (SECRET_MASK), never in clear text. */
export interface ChannelDetail extends Channel {
  config: Record<string, unknown>;
}

export interface ChannelBody {
  name: string;
  config: Record<string, unknown>;
  rules: ChannelRules;
}

export type TestResult = { ok: true } | { ok: false; error: string };

export interface AlertPolicy {
  id: string;
  name: string;
  isDefault: boolean;
  rules: { channelIds: string[]; events: Record<string, boolean> };
}

export interface SlackInstallation {
  id: string;
  teamId: string;
  teamName: string;
}

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
}

export const integrationsApi = {
  channels: (ws: string) => api<{ data: Channel[] }>(wsPath(ws, "/channels")),
  /* Which channel types this server can deliver to (the Slack app and Telegram need its keys). */
  channelTypes: (ws: string) =>
    api<{ data: Array<{ type: ChannelType; available: boolean }> }>(wsPath(ws, "/channels/types")),
  channel: (ws: string, id: string) => api<ChannelDetail>(wsPath(ws, `/channels/${id}`)),
  /* SMS and voice: what a number costs in credits, and its verification by one-time code. */
  phoneCost: (ws: string, phone: string) =>
    api<PhoneCost>(wsPath(ws, `/phone-numbers/cost?phone=${encodeURIComponent(phone)}`)),
  sendPhoneCode: (ws: string, phone: string) =>
    api<PhoneCost & { expiresAt: string }>(wsPath(ws, "/phone-numbers/codes"), {
      method: "POST",
      body: { phone },
    }),
  confirmPhone: (ws: string, phone: string, code: string) =>
    api<{ verified: true }>(wsPath(ws, "/phone-numbers/confirm"), {
      method: "POST",
      body: { phone, code },
    }),
  createChannel: (
    ws: string,
    body: {
      type: ChannelType;
      name: string;
      config: Record<string, unknown>;
      rules?: ChannelRules;
    },
  ) => api<ChannelDetail>(wsPath(ws, "/channels"), { method: "POST", body }),
  updateChannel: (ws: string, id: string, body: Partial<ChannelBody>) =>
    api<ChannelDetail>(wsPath(ws, `/channels/${id}`), { method: "PATCH", body }),
  removeChannel: (ws: string, id: string) =>
    api<void>(wsPath(ws, `/channels/${id}`), { method: "DELETE" }),
  sendTest: (ws: string, id: string) =>
    api<TestResult>(wsPath(ws, `/channels/${id}/test`), { method: "POST", body: {} }),
  policies: (ws: string) => api<{ data: AlertPolicy[] }>(wsPath(ws, "/alert-policies")),
  slackInstallUrl: (ws: string) => api<{ url: string }>(wsPath(ws, "/integrations/slack/install")),
  slackInstallations: (ws: string) =>
    api<{ data: SlackInstallation[] }>(wsPath(ws, "/integrations/slack/installations")),
  slackChannels: (ws: string, installationId: string) =>
    api<{ data: SlackChannel[] }>(
      wsPath(ws, `/integrations/slack/installations/${installationId}/channels`),
    ),
  telegramLink: (ws: string, channelId: string) =>
    api<{ url: string }>(wsPath(ws, `/channels/${channelId}/telegram-link`), {
      method: "POST",
      body: {},
    }),
};

/* Adds a channel to the workspace's default policy, so every alert reaches it. Idempotent. */
export async function addToDefaultPolicy(ws: string, channelId: string): Promise<void> {
  await api<AlertPolicy>(wsPath(ws, `/alert-policies/default/channels/${channelId}`), {
    method: "PUT",
    body: {},
  });
}

export const integrationKeys = {
  channels: (ws: string) => ["channels", ws] as const,
  channel: (ws: string, id: string) => ["channel", ws, id] as const,
  types: (ws: string) => ["channel-types", ws] as const,
  policies: (ws: string) => ["alert-policies", ws] as const,
  /* What happened right after a channel was created, shown once on its page. */
  setup: (ws: string, id: string) => ["channel-setup", ws, id] as const,
};

export interface SetupOutcome {
  /* null when no test was sent (the test would page someone, or the chat isn't linked yet). */
  test: TestResult | null;
  /* Why the channel couldn't be added to the default alert policy; null when it was. */
  routingError: string | null;
}
