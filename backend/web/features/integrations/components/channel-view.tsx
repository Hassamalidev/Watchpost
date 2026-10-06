/*
 * One connected integration: its health and last delivery, "Send test", its settings and rules, and
 * what is specific to its type (a webhook's signing secret, a Telegram chat to link). Right after
 * setup it also says whether the first test alert arrived.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Trash2 } from "lucide-react";
import { CHANNEL_CAPABILITIES, integrationForChannel } from "@app/shared";
import { can, useWorkspace } from "@/components/app/workspace-context";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyField } from "@/components/ui/copy-field";
import { Loading } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { workspaceHref } from "@/lib/navigation";
import { integrationKeys, integrationsApi, type ChannelDetail, type SetupOutcome } from "../api";
import { ChannelForm } from "./channel-form";
import { BackToIntegrations, HealthBadge, IntegrationTile, SendTestButton } from "./parts";

/* Shown once, right after setup: connected, and whether the first test alert made it. */
function SetupBanner({ channel, outcome }: { channel: ChannelDetail; outcome: SetupOutcome }) {
  const t = useTranslations("integrations");
  const created = t("created", { name: channel.name });
  if (outcome.routingError !== null) {
    return <Alert tone="error">{t("notRouted", { error: outcome.routingError })}</Alert>;
  }
  if (outcome.test === null) {
    return (
      <Alert tone="success">
        {created} {channel.type === "telegram" ? t("telegramUnlinked") : t("notTested")}
      </Alert>
    );
  }
  return outcome.test.ok ? (
    <Alert tone="success">
      {created} {t("testDelivered")}
    </Alert>
  ) : (
    <Alert tone="error">{t("testFailedAfterSave", { error: outcome.test.error })}</Alert>
  );
}

function TelegramCard({ ws, channel }: { ws: string; channel: ChannelDetail }) {
  const t = useTranslations("integrations");
  const link = useMutation({ mutationFn: () => integrationsApi.telegramLink(ws, channel.id) });
  const chat = typeof channel.config.chatTitle === "string" ? channel.config.chatTitle : null;
  const linked = channel.config.chatId != null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("telegramTitle")}</CardTitle>
        <CardDescription>
          {linked ? t("telegramLinked", { chat: chat ?? "Telegram" }) : t("telegramUnlinked")}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {link.isError && <Alert tone="error">{errorMessage(link.error)}</Alert>}
        {link.data ? (
          <>
            <p>
              <a href={link.data.url} target="_blank" rel="noreferrer" className="underline">
                {t("telegramOpen")}
              </a>
            </p>
            {!linked && (
              <p role="status" className="text-muted-foreground">
                {t("telegramWaiting")}
              </p>
            )}
          </>
        ) : (
          <div>
            <Button
              type="button"
              variant={linked ? "outline" : "default"}
              disabled={link.isPending}
              onClick={() => link.mutate()}
            >
              {linked ? t("telegramRelink") : t("telegramGetLink")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ChannelView({ channelId }: { channelId: string }) {
  const t = useTranslations("integrations");
  const workspace = useWorkspace();
  const ws = workspace.id;
  const router = useRouter();
  const client = useQueryClient();
  const isAdmin = can(workspace.role, "channel:manage");
  const detail = useQuery({
    queryKey: integrationKeys.channel(ws, channelId),
    queryFn: () => integrationsApi.channel(ws, channelId),
    enabled: isAdmin,
    /* A Telegram channel becomes usable when its link is opened in Telegram; watch for it. */
    refetchInterval: (query) =>
      query.state.data?.type === "telegram" && query.state.data.config.chatId == null
        ? 3_000
        : false,
  });
  /* Written by the setup page just before it navigated here; read once, absent on later visits. */
  const [outcome] = React.useState(
    () => client.getQueryData<SetupOutcome>(integrationKeys.setup(ws, channelId)) ?? null,
  );
  React.useEffect(() => {
    client.removeQueries({ queryKey: integrationKeys.setup(ws, channelId) });
  }, [client, ws, channelId]);
  const remove = useMutation({
    mutationFn: () => integrationsApi.removeChannel(ws, channelId),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: integrationKeys.channels(ws) });
      router.push(workspaceHref(ws, "integrations"));
    },
  });

  if (!isAdmin) {
    return (
      <div className="grid max-w-2xl gap-4">
        <BackToIntegrations ws={ws} />
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <Alert tone="info">{t("adminOnly")}</Alert>
      </div>
    );
  }
  if (detail.isPending) {
    return (
      <div className="grid max-w-2xl gap-4">
        <BackToIntegrations ws={ws} />
        <Loading rows={3} />
      </div>
    );
  }
  if (detail.isError) {
    return (
      <div className="grid max-w-2xl gap-4">
        <BackToIntegrations ws={ws} />
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <Alert tone="error">{errorMessage(detail.error)}</Alert>
      </div>
    );
  }

  const channel = detail.data;
  const integration = integrationForChannel(channel.type, channel.config);
  const secret = typeof channel.config.secret === "string" ? channel.config.secret : null;
  const slackChannel =
    typeof channel.config.channelName === "string" ? channel.config.channelName : null;

  return (
    <div className="grid max-w-2xl gap-6">
      <BackToIntegrations ws={ws} />
      <div className="flex items-start gap-3">
        <IntegrationTile id={integration.id} className="size-12 text-sm" />
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{channel.name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {integration.name}
            <HealthBadge channel={channel} />
          </p>
        </div>
      </div>
      {outcome && <SetupBanner channel={channel} outcome={outcome} />}

      <Card>
        <CardHeader>
          <CardTitle>{t("delivery")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">{t("lastSuccess")}</dt>
            <dd>
              {channel.lastSuccessAt ? formatDateTime(channel.lastSuccessAt) : t("noDeliveriesYet")}
            </dd>
            {channel.lastFailureAt && (
              <>
                <dt className="text-muted-foreground">{t("lastFailure")}</dt>
                <dd>{formatDateTime(channel.lastFailureAt)}</dd>
              </>
            )}
          </dl>
          {channel.status !== "healthy" && channel.lastError && (
            <p className="break-words text-status-down">{channel.lastError}</p>
          )}
          {slackChannel && <p>{t("slackPostsTo", { channel: slackChannel })}</p>}
          {CHANNEL_CAPABILITIES[channel.type].testPages && (
            <p className="text-muted-foreground">{t("pagesNote", { name: integration.name })}</p>
          )}
          <SendTestButton ws={ws} channel={channel} variant="default" />
        </CardContent>
      </Card>

      {channel.type === "telegram" && <TelegramCard ws={ws} channel={channel} />}

      {secret && (
        <Card>
          <CardHeader>
            <CardTitle>{t("signingSecret")}</CardTitle>
            <CardDescription>{t("signingSecretHint")}</CardDescription>
          </CardHeader>
          <CardContent>
            <CopyField label={t("signingSecret")} value={secret} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("settings")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ChannelForm
            key={channel.id}
            ws={ws}
            integration={integration}
            channel={channel}
            submitLabel={t("save")}
            onSaved={async (saved) => {
              client.setQueryData(integrationKeys.channel(ws, channelId), saved);
              await client.invalidateQueries({ queryKey: integrationKeys.channels(ws) });
            }}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("removeTitle")}</CardTitle>
          <CardDescription>{t("removeHint")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {remove.isError && <Alert tone="error">{errorMessage(remove.error)}</Alert>}
          <div>
            <Button
              type="button"
              variant="outline"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(t("confirmRemove", { name: channel.name }))) remove.mutate();
              }}
            >
              <Trash2 aria-hidden />
              {t("remove")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
