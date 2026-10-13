/*
 * Integrations, in four sections picked by `?tab=`: alert channels (what is connected, with health,
 * last delivery, what each one accepts and "Send test", then the gallery of everything that can be
 * added), inbound alerts, outgoing webhooks and deploy markers. Admins manage; everyone else sees
 * names and health. A channel outside every alert policy gets no alerts, so the list says so and
 * offers the fix.
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
import { cn } from "@/lib/utils";
import { InboundSources, useInboundSources } from "./inbound-sources";
import { OutgoingWebhooks, useWebhookEndpoints } from "./outgoing-webhooks";
import { DeployHookCard } from "@/features/insights/components/deploy-hook";
import { DrillCard } from "@/features/insights/components/drill";
import { addToDefaultPolicy, integrationKeys, integrationsApi, type Channel } from "../api";
import {
  INTEGRATION_TABS,
  channelHealth,
  connectedCounts,
  tabOf,
  type IntegrationTab,
} from "../catalog";
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
  const health = channelHealth(channel);

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3">
      <IntegrationTile id={channel.integration} />
      <div className="min-w-0 flex-1 basis-48">
        <p className="flex min-w-0 items-center gap-2">
          {isAdmin ? (
            <Link
              href={workspaceHref(ws, `integrations/${channel.id}`)}
              className="truncate font-medium hover:underline"
            >
              {channel.name}
            </Link>
          ) : (
            <span className="truncate font-medium">{channel.name}</span>
          )}
          <HealthBadge channel={channel} />
        </p>
        <p className="text-xs text-muted-foreground">
          {findIntegration(channel.integration)?.name ?? CHANNEL_LABELS[channel.type]} ·{" "}
          {channel.lastSuccessAt
            ? `${t("lastSuccess")}: ${relativeTime(channel.lastSuccessAt)}`
            : t("noDeliveriesYet")}{" "}
          · <RulesSummary rules={channel.rules} />
        </p>
        {(health === "failing" || health === "lastFailed") && channel.lastError && (
          <p
            className={cn(
              "mt-1 text-xs break-words",
              health === "failing" ? "text-status-down" : "text-status-degraded",
            )}
          >
            {channel.lastError}
          </p>
        )}
        {(route.isError || remove.isError) && (
          <p role="alert" className="mt-1 text-xs break-words text-status-down">
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
      {isAdmin && (
        <div className="flex flex-wrap items-center gap-1">
          <SendTestButton ws={ws} channel={channel} />
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

/* The sections as links, so each has an address, the back button works and a reload stays put. */
function SectionNav({
  ws,
  current,
  counts,
  attention,
}: {
  ws: string;
  current: IntegrationTab;
  counts: Partial<Record<IntegrationTab, number>>;
  /* Connected channels that are failing or get no alerts. */
  attention: number;
}) {
  const t = useTranslations("integrations");
  return (
    <nav aria-label={t("tabs.label")} className="-mx-1 overflow-x-auto border-b">
      <ul className="flex min-w-max gap-1 px-1">
        {INTEGRATION_TABS.map((tab) => {
          const count = counts[tab];
          return (
            <li key={tab}>
              <Link
                href={workspaceHref(
                  ws,
                  tab === "channels" ? "integrations" : `integrations?tab=${tab}`,
                )}
                scroll={false}
                aria-current={tab === current ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex h-10 items-center gap-2 border-b-2 px-3 text-sm whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                  tab === current
                    ? "border-foreground font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                )}
              >
                {t(`tabs.${tab}`)}
                {count !== undefined && count > 0 && (
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs leading-none font-medium text-foreground tabular-nums">
                    {count}
                  </span>
                )}
                {tab === "channels" && attention > 0 && (
                  <span className="inline-flex items-center gap-1 text-xs text-status-degraded">
                    <TriangleAlert aria-hidden className="size-3.5" />
                    <span className="sr-only">{t("needsAttention", { count: attention })}</span>
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function IntegrationsPage() {
  const t = useTranslations("integrations");
  const workspace = useWorkspace();
  const ws = workspace.id;
  const router = useRouter();
  const search = useSearchParams();
  const tab = tabOf(search.get("tab"));
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
  /* Only their counts are used here; the sections read the same cached lists. */
  const inbound = useInboundSources(ws);
  const webhooks = useWebhookEndpoints(ws);

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
  const isRouted = (channel: Channel) => policies.data === undefined || routedIds.has(channel.id);
  const attention = list.filter((channel) => {
    const health = channelHealth(channel);
    return health === "failing" || health === "lastFailed" || !isRouted(channel);
  }).length;

  return (
    <div className="grid max-w-5xl grid-cols-[minmax(0,1fr)] gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-1 max-w-2xl text-muted-foreground">{t("intro")}</p>
      </div>
      <SectionNav
        ws={ws}
        current={tab}
        counts={{
          channels: list.length,
          inbound: inbound.data?.length ?? 0,
          webhooks: webhooks.data?.length ?? 0,
        }}
        attention={attention}
      />
      <p className="-mt-2 text-sm text-muted-foreground">{t(`tabs.hint.${tab}`)}</p>

      {tab === "channels" && (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-8">
          <section
            className="grid grid-cols-[minmax(0,1fr)] gap-2"
            aria-labelledby="channels-heading"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="channels-heading" className="text-base font-semibold">
                {t("connected")}
              </h2>
              {attention > 0 && (
                <p className="inline-flex items-center gap-1 text-xs text-status-degraded">
                  <TriangleAlert aria-hidden className="size-3.5" />
                  {t("needsAttention", { count: attention })}
                </p>
              )}
            </div>
            {channels.isPending ? (
              <Loading rows={2} />
            ) : channels.isError ? (
              <Alert tone="error">{errorMessage(channels.error)}</Alert>
            ) : list.length === 0 ? (
              <EmptyState title={t("empty")}>{isAdmin && <p>{t("emptyHint")}</p>}</EmptyState>
            ) : (
              <ul className="divide-y rounded-lg border bg-card shadow-xs">
                {list.map((channel) => (
                  <ChannelRow
                    key={channel.id}
                    ws={ws}
                    channel={channel}
                    isAdmin={isAdmin}
                    routed={isRouted(channel)}
                  />
                ))}
              </ul>
            )}
          </section>
          {isAdmin && (
            <IntegrationGallery
              ws={ws}
              availability={availability}
              connected={connectedCounts(list)}
            />
          )}
          {isAdmin && list.length > 0 && <DrillCard ws={ws} />}
        </div>
      )}
      {tab === "inbound" && <InboundSources ws={ws} canManage={isAdmin} />}
      {tab === "webhooks" && <OutgoingWebhooks ws={ws} canManage={isAdmin} />}
      {tab === "deploys" && <DeployHookCard ws={ws} canManage={isAdmin} />}
    </div>
  );
}
