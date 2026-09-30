/* Typed calls for alert channels, the default alert policy, "Send test" and chat app setup. */
import type { ChannelType } from "@app/shared";
import { api, wsPath } from "@/lib/api";

export interface Channel {
  id: string;
  type: ChannelType;
  name: string;
  status: "healthy" | "failing";
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
}

export interface AlertPolicy {
  id: string;
  name: string;
  isDefault: boolean;
  rules: { channelIds: string[]; events: Record<string, boolean> };
}

export const integrationsApi = {
  channels: (ws: string) => api<{ data: Channel[] }>(wsPath(ws, "/channels")),
  createChannel: (
    ws: string,
    body: { type: ChannelType; name: string; config: Record<string, unknown> },
  ) => api<Channel>(wsPath(ws, "/channels"), { method: "POST", body }),
  removeChannel: (ws: string, id: string) =>
    api<void>(wsPath(ws, `/channels/${id}`), { method: "DELETE" }),
  sendTest: (ws: string, id: string) =>
    api<{ ok: true } | { ok: false; error: string }>(wsPath(ws, `/channels/${id}/test`), {
      method: "POST",
      body: {},
    }),
  policies: (ws: string) => api<{ data: AlertPolicy[] }>(wsPath(ws, "/alert-policies")),
  updatePolicy: (ws: string, id: string, rules: AlertPolicy["rules"]) =>
    api<AlertPolicy>(wsPath(ws, `/alert-policies/${id}`), { method: "PATCH", body: { rules } }),
  slackInstallUrl: (ws: string) => api<{ url: string }>(wsPath(ws, "/integrations/slack/install")),
  telegramLink: (ws: string, channelId: string) =>
    api<{ url: string }>(wsPath(ws, `/channels/${channelId}/telegram-link`), {
      method: "POST",
      body: {},
    }),
};

/* Adds a channel to the workspace's default policy, so every alert reaches it. */
export async function addToDefaultPolicy(ws: string, channelId: string): Promise<void> {
  const policy = (await integrationsApi.policies(ws)).data.find((p) => p.isDefault);
  if (policy === undefined || policy.rules.channelIds.includes(channelId)) return;
  await integrationsApi.updatePolicy(ws, policy.id, {
    ...policy.rules,
    channelIds: [...policy.rules.channelIds, channelId],
  });
}
