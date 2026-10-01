/* Small pieces shared by the integrations screens: the tile, health, rules summary and "Send test". */
"use client";

import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ArrowLeft, CircleCheck, CircleX, Send } from "lucide-react";
import {
  CHANNEL_CAPABILITIES,
  CHANNEL_LABELS,
  type ChannelRules,
  type IntegrationId,
} from "@app/shared";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { workspaceHref } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { integrationKeys, integrationsApi, type Channel, type TestResult } from "../api";
import { MONOGRAMS, rulesSummary } from "../catalog";

export function BackToIntegrations({ ws }: { ws: string }) {
  const t = useTranslations("integrations");
  return (
    <Link
      href={workspaceHref(ws, "integrations")}
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft aria-hidden className="size-4" />
      {t("back")}
    </Link>
  );
}

/* A neutral square with the integration's initials; decorative, the name is always next to it. */
export function IntegrationTile({ id, className }: { id: IntegrationId; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-10 shrink-0 place-items-center rounded-md border bg-muted font-mono text-xs font-semibold",
        className,
      )}
    >
      {MONOGRAMS[id]}
    </span>
  );
}

export function HealthBadge({ channel }: { channel: Pick<Channel, "status" | "lastError"> }) {
  const t = useTranslations("integrations");
  return channel.status === "healthy" ? (
    <span className="inline-flex items-center gap-1 text-xs text-status-up">
      <CircleCheck aria-hidden className="size-3.5" />
      {t("healthy")}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs text-status-down">
      <CircleX aria-hidden className="size-3.5" />
      {t("failing")}
    </span>
  );
}

/* "High and critical · no reminders", or "All alerts". */
export function RulesSummary({ rules }: { rules: ChannelRules }) {
  const t = useTranslations("integrations");
  const summary = rulesSummary(rules);
  if (summary === null) return <>{t("rulesSummary.all")}</>;
  const parts = [
    ...(summary.severity === "low" ? [] : [t(`rulesSummary.${summary.severity}`)]),
    ...summary.without.map((kind) => t(`rulesSummary.without.${kind}`)),
  ];
  return <>{parts.join(" · ")}</>;
}

export function TestOutcome({ result }: { result: TestResult | undefined }) {
  const t = useTranslations("integrations");
  if (result === undefined) return null;
  return result.ok ? (
    <span className="text-status-up">{t("testOk")}</span>
  ) : (
    <span className="text-status-down">{t("testFailed", { error: result.error })}</span>
  );
}

/* Sends one test alert and says what happened. On-call tools page people, so those ask first. */
export function SendTestButton({
  ws,
  channel,
  variant = "outline",
}: {
  ws: string;
  channel: Pick<Channel, "id" | "type" | "name">;
  variant?: "outline" | "default";
}) {
  const t = useTranslations("integrations");
  const client = useQueryClient();
  const test = useMutation({
    mutationFn: () => integrationsApi.sendTest(ws, channel.id),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: integrationKeys.channels(ws) }),
        client.invalidateQueries({ queryKey: integrationKeys.channel(ws, channel.id) }),
      ]),
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant={variant}
        disabled={test.isPending}
        aria-label={`${t("sendTest")}: ${channel.name}`}
        onClick={() => {
          if (
            CHANNEL_CAPABILITIES[channel.type].testPages &&
            !window.confirm(t("confirmTestPages", { name: CHANNEL_LABELS[channel.type] }))
          ) {
            return;
          }
          test.mutate();
        }}
      >
        <Send aria-hidden />
        {t("sendTest")}
      </Button>
      <span aria-live="polite" className="text-xs">
        <TestOutcome result={test.data} />
        {test.isError && (
          <span className="text-status-down">
            {t("testFailed", { error: errorMessage(test.error) })}
          </span>
        )}
      </span>
    </div>
  );
}
