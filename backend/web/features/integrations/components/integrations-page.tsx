/*
 * Integrations: what is connected (health, last delivery, what each one accepts, "Send test") and the
 * gallery of everything that can be added. Admins manage; everyone else sees names and health.
 * A channel outside every alert policy gets no alerts, so the list says so and offers the fix.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Pencil, Trash2, TriangleAlert } from "lucide-react";
import { CHANNEL_LABELS, findIntegration, type ChannelType } from "@app/shared";
import { can, useWorkspace } from "@/components/app/workspace-context";
import { Alert, EmptyState } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Loading } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { workspaceHref } from "@/lib/navigation";
import { DeployHookCard } from "@/features/insights/components/deploy-hook";
import { DrillCard } from "@/features/insights/components/drill";
import { addToDefaultPolicy, integrationKeys, integrationsApi, type Channel } from "../api";
import { useChannelTypes } from "../hooks";
import { IntegrationGallery } from "./integration-gallery";
import { HealthBadge, IntegrationTile, RulesSummary, SendTestButton } from "./parts";

function ChannelRow({
  ws,
  channel,
  isAdmin,
  routed,
}: {
  ws: string;
  channel: Channel;
  isAdmin: boolean;
  /* False when no alert policy sends to this channel. */
  routed: boolean;
}) {
  const t = useTranslations("integrations");
  const client = useQueryClient();
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: integrationKeys.channels(ws) }),
      client.invalidateQueries({ queryKey: integrationKeys.policies(ws) }),
    ]);
  const route = useMutation({
    mutationFn: () => addToDefaultPolicy(ws, channel.id),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => integrationsApi.removeChannel(ws, channel.id),
    onSuccess: refresh,
  });

  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-3">
      <IntegrationTile id={channel.integration} />
      <div className="min-w-0 flex-1 basis-48">
        <p className="truncate font-medium">{channel.name}</p>
        <p className="text-xs text-muted-foreground">
          {findIntegration(channel.integration)?.name ?? CHANNEL_LABELS[channel.type]} ·{" "}
          {channel.lastSuccessAt
            ? `${t("lastSuccess")}: ${relativeTime(channel.lastSuccessAt)}`
            : t("noDeliveriesYet")}{" "}
          · <RulesSummary rules={channel.rules} />
        </p>
        {channel.status !== "healthy" && channel.lastError && (
          <p className="mt-1 break-words text-xs text-status-down">{channel.lastError}</p>
        )}
        {(route.isError || remove.isError) && (
          <p role="alert" className="mt-1 break-words text-xs text-status-down">
            {errorMessage(route.error ?? remove.error)}
          </p>
        )}
        {!routed && (
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-status-degraded">
            <span className="inline-flex items-center gap-1">
              <TriangleAlert aria-hidden className="size-3.5" />
              {t("notInPolicy")}: {t("notInPolicyHint")}
            </span>
            {isAdmin && (
              <button
                type="button"
                className="underline"
                disabled={route.isPending}
                onClick={() => route.mutate()}
              >
                {t("addToPolicy")}
              </button>
            )}
          </p>
        )}
      </div>
      <HealthBadge channel={channel} />
      {isAdmin && <SendTestButton ws={ws} channel={channel} />}
      {isAdmin && (
        <div className="flex gap-1">
          <Link
            href={workspaceHref(ws, `integrations/${channel.id}`)}
            aria-label={t("editAria", { name: channel.name })}
            className={buttonVariants({ size: "sm", variant: "ghost" })}
          >
            <Pencil aria-hidden />
          </Link>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`${t("remove")} ${channel.name}`}
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(t("confirmRemove", { name: channel.name }))) remove.mutate();
            }}
          >
            <Trash2 aria-hidden />
          </Button>
        </div>
      )}
    </li>
  );
}

export function IntegrationsPage() {
  const t = useTranslations("integrations");
  const workspace = useWorkspace();
  const ws = workspace.id;
  const router = useRouter();
  const search = useSearchParams();
  const isAdmin = can(workspace.role, "channel:manage");
  const channels = useQuery({
    queryKey: integrationKeys.channels(ws),
    queryFn: async () => (await integrationsApi.channels(ws)).data,
  });
  const policies = useQuery({
    queryKey: integrationKeys.policies(ws),
    queryFn: async () => (await integrationsApi.policies(ws)).data,
  });
  const types = useChannelTypes(ws);

  /* Slack sends the browser back here after the install; the channel picker is the next step. */
  const slack = search.get("slack");
  React.useEffect(() => {
    if (slack === "installed") router.replace(workspaceHref(ws, "integrations/new/slack"));
  }, [slack, router, ws]);

  const routedIds = new Set((policies.data ?? []).flatMap((p) => p.rules.channelIds));
  const availability = types.data
    ? new Map<ChannelType, boolean>(types.data.map((entry) => [entry.type, entry.available]))
    : undefined;
  const list = channels.data ?? [];

  return (
    <div className="grid max-w-5xl gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-1 max-w-2xl text-muted-foreground">{t("intro")}</p>
      </div>
      <section className="grid gap-2" aria-labelledby="channels-heading">
        <h2 id="channels-heading" className="text-base font-semibold">
          {t("connected")}
        </h2>
        {channels.isPending ? (
          <Loading rows={2} />
        ) : channels.isError ? (
          <Alert tone="error">{errorMessage(channels.error)}</Alert>
        ) : list.length === 0 ? (
          <EmptyState title={t("empty")}>{isAdmin && <p>{t("emptyHint")}</p>}</EmptyState>
        ) : (
          <ul className="divide-y rounded-lg border">
            {list.map((channel) => (
              <ChannelRow
                key={channel.id}
                ws={ws}
                channel={channel}
                isAdmin={isAdmin}
                routed={policies.data === undefined || routedIds.has(channel.id)}
              />
            ))}
          </ul>
        )}
      </section>
      {isAdmin && <IntegrationGallery ws={ws} availability={availability} />}
      {isAdmin && list.length > 0 && <DrillCard ws={ws} />}
      <DeployHookCard ws={ws} canManage={isAdmin} />
    </div>
  );
}
