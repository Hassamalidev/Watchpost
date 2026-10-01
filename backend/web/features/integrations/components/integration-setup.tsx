/*
 * Setting up one integration from the gallery: what to do in the other tool, then the form. Saving
 * adds the channel to the default alert policy and sends a test alert right away, so "connected"
 * means "we saw it work". Tools that page people aren't tested automatically; the next page offers
 * the test with a warning instead.
 */
"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { CHANNEL_CAPABILITIES, findIntegration, type IntegrationDefinition } from "@app/shared";
import { can, useWorkspace } from "@/components/app/workspace-context";
import { Alert, EmptyState } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { workspaceHref } from "@/lib/navigation";
import { useChannelTypes, useFinishSetup } from "../hooks";
import { ChannelForm } from "./channel-form";
import { BackToIntegrations, IntegrationTile } from "./parts";
import { SlackSetup } from "./slack-setup";

function SetupBody({
  ws,
  email,
  integration,
}: {
  ws: string;
  email: string;
  integration: IntegrationDefinition;
}) {
  const t = useTranslations("integrations");
  const finish = useFinishSetup(ws, integration);
  const { setup, testPages } = CHANNEL_CAPABILITIES[integration.type];
  const types = useChannelTypes(ws);
  const available = types.data?.find((entry) => entry.type === integration.type)?.available;

  if (available === false) {
    return (
      <Alert tone="info">
        {integration.type === "slack" ? (
          <>
            {t("unavailableSlack")}{" "}
            <Link href={workspaceHref(ws, "integrations/new/slack-webhook")} className="underline">
              {t("useSlackWebhook")}
            </Link>
          </>
        ) : (
          t("unavailableTelegram")
        )}
      </Alert>
    );
  }
  if (setup === "oauth") return <SlackSetup ws={ws} integration={integration} />;
  return (
    <>
      {testPages && <Alert tone="info">{t("pagesNote", { name: integration.name })}</Alert>}
      <ChannelForm
        ws={ws}
        integration={integration}
        submitLabel={
          setup === "link" ? t("telegramCreate") : testPages ? t("save") : t("saveAndTest")
        }
        {...(integration.type === "email" ? { defaults: { to: email } } : {})}
        /* A Telegram channel has no chat until its link is opened, so there is nothing to test. */
        onSaved={(channel) => finish(channel, { test: setup === "form" })}
      />
    </>
  );
}

export function IntegrationSetup({ integrationId }: { integrationId: string }) {
  const t = useTranslations("integrations");
  const workspace = useWorkspace();
  const ws = workspace.id;
  const integration = findIntegration(integrationId);

  if (integration === undefined) {
    return (
      <div className="grid max-w-2xl gap-4">
        <BackToIntegrations ws={ws} />
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <EmptyState title={t("notFound")} />
      </div>
    );
  }
  const steps = t(`catalog.${integration.id}.steps`).split("\n");
  const noteKey = `catalog.${integration.id}.note` as const;

  return (
    <div className="grid max-w-2xl gap-6">
      <BackToIntegrations ws={ws} />
      <div className="flex items-start gap-3">
        <IntegrationTile id={integration.id} className="size-12 text-sm" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("setupTitle", { name: integration.name })}
          </h1>
          <p className="mt-1 text-muted-foreground">{t(`catalog.${integration.id}.summary`)}</p>
        </div>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t("setupSteps")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <ol className="grid list-decimal gap-1.5 pl-5">
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {t.has(noteKey as never) && (
            <p className="text-muted-foreground">{(t as (key: string) => string)(noteKey)}</p>
          )}
        </CardContent>
      </Card>
      {can(workspace.role, "admin") ? (
        <SetupBody ws={ws} email={workspace.user.email} integration={integration} />
      ) : (
        <Alert tone="info">{t("adminOnly")}</Alert>
      )}
    </div>
  );
}
