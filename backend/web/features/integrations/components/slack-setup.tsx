/*
 * The Slack app: install it in a Slack workspace (OAuth), then pick the channel alerts go to. The
 * install sends the browser to Slack and back to this page, where the channel picker is the next
 * step. A Watchpost workspace can connect several Slack workspaces.
 */
"use client";

import * as React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { ChannelRules, IntegrationDefinition } from "@app/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/input";
import { Loading } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api";
import { integrationsApi } from "../api";
import { defaultRulesFor } from "../catalog";
import { useFinishSetup } from "../hooks";
import { RulesFields } from "./rules-fields";

export function SlackSetup({
  ws,
  integration,
}: {
  ws: string;
  integration: IntegrationDefinition;
}) {
  const t = useTranslations("integrations");
  const finish = useFinishSetup(ws, integration);
  const [installationId, setInstallationId] = React.useState("");
  const [channelId, setChannelId] = React.useState("");
  const [rules, setRules] = React.useState<ChannelRules>(defaultRulesFor(integration));

  const installations = useQuery({
    queryKey: ["slack-installations", ws],
    queryFn: async () => (await integrationsApi.slackInstallations(ws)).data,
  });
  const selected = installationId || installations.data?.[0]?.id || "";
  const channels = useQuery({
    queryKey: ["slack-channels", ws, selected],
    queryFn: async () => (await integrationsApi.slackChannels(ws, selected)).data,
    enabled: selected !== "",
  });
  const install = useMutation({
    mutationFn: async () => {
      window.location.assign((await integrationsApi.slackInstallUrl(ws)).url);
    },
  });
  const create = useMutation({
    mutationFn: async () => {
      const channel = channels.data?.find((c) => c.id === channelId);
      if (channel === undefined) return;
      const created = await integrationsApi.createChannel(ws, {
        type: "slack",
        name: `Slack #${channel.name}`,
        config: { installationId: selected, channelId: channel.id, channelName: channel.name },
        rules,
      });
      await finish(created, { test: true });
    },
  });

  if (installations.isPending) return <Loading rows={2} />;
  const installButton = (label: string, variant: "default" | "outline") => (
    <Button
      type="button"
      variant={variant}
      disabled={install.isPending}
      onClick={() => install.mutate()}
    >
      {label}
    </Button>
  );
  if ((installations.data ?? []).length === 0) {
    return (
      <div className="grid gap-3">
        {install.isError && <Alert tone="error">{errorMessage(install.error)}</Alert>}
        <p className="text-sm text-muted-foreground">{t("slackNoInstall")}</p>
        <div>{installButton(t("slackConnect"), "default")}</div>
      </div>
    );
  }

  return (
    <form
      className="grid max-w-xl gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <Alert tone="success">{t("slackInstalled")}</Alert>
      {(create.isError || channels.isError || install.isError) && (
        <Alert tone="error">{errorMessage(create.error ?? channels.error ?? install.error)}</Alert>
      )}
      <Field label={t("slackWorkspace")} htmlFor="slack-installation">
        <Select
          id="slack-installation"
          value={selected}
          onChange={(e) => {
            setInstallationId(e.target.value);
            setChannelId("");
          }}
        >
          {(installations.data ?? []).map((i) => (
            <option key={i.id} value={i.id}>
              {i.teamName}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("slackChannel")} htmlFor="slack-channel">
        <Select
          id="slack-channel"
          required
          value={channelId}
          disabled={channels.isPending}
          onChange={(e) => setChannelId(e.target.value)}
        >
          <option value="">{t("slackPickChannel")}</option>
          {(channels.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              #{c.name}
              {c.isPrivate ? ` (${t("slackPrivate")})` : ""}
            </option>
          ))}
        </Select>
      </Field>
      <RulesFields value={rules} onChange={setRules} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={create.isPending || channelId === ""}>
          {create.isPending ? t("saving") : t("saveAndTest")}
        </Button>
        {installButton(t("slackAnother"), "outline")}
      </div>
    </form>
  );
}
