/*
 * Integrations: every channel with its health and last delivery, "Send test", and a form to add
 * email, webhook, Discord, Teams, Slack or Telegram channels. New channels join the default alert
 * policy so they receive alerts right away.
 */
"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { CircleCheck, CircleX, Send, Trash2 } from "lucide-react";
import type { ChannelType } from "@app/shared";
import { can, useWorkspace } from "@/components/app/workspace-context";
import { Alert, EmptyState } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Loading } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { DrillCard } from "@/features/insights/components/drill";
import { addToDefaultPolicy, integrationsApi, type Channel } from "../api";

const FORM_TYPES: ChannelType[] = ["email", "webhook", "discord", "teams", "slack", "telegram"];

function SendTestButton({ ws, channel }: { ws: string; channel: Channel }) {
  const t = useTranslations("integrations");
  const client = useQueryClient();
  const test = useMutation({
    mutationFn: () => integrationsApi.sendTest(ws, channel.id),
    onSettled: () => client.invalidateQueries({ queryKey: ["channels", ws] }),
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
        <Send aria-hidden />
        {t("sendTest")}
      </Button>
      <span aria-live="polite" className="text-xs">
        {test.data?.ok === true && <span className="text-status-up">{t("testOk")}</span>}
        {test.data?.ok === false && (
          <span className="text-status-down">{t("testFailed", { error: test.data.error })}</span>
        )}
        {test.isError && (
          <span className="text-status-down">
            {t("testFailed", { error: errorMessage(test.error) })}
          </span>
        )}
      </span>
    </div>
  );
}

function AddChannelForm({ ws, email }: { ws: string; email: string }) {
  const t = useTranslations("integrations");
  const client = useQueryClient();
  const [type, setType] = React.useState<ChannelType>("email");
  const [name, setName] = React.useState("");
  const [value, setValue] = React.useState(email);
  const [error, setError] = React.useState<string | null>(null);
  const [telegramUrl, setTelegramUrl] = React.useState<string | null>(null);

  const create = useMutation({
    mutationFn: async () => {
      if (type === "slack") {
        window.location.assign((await integrationsApi.slackInstallUrl(ws)).url);
        return;
      }
      const config =
        type === "email"
          ? {
              to: value
                .split(",")
                .map((v) => v.trim())
                .filter(Boolean),
            }
          : type === "telegram"
            ? {}
            : { url: value.trim() };
      const channel = await integrationsApi.createChannel(ws, {
        type,
        name: name.trim() || t(`types.${type}`),
        config,
      });
      await addToDefaultPolicy(ws, channel.id);
      if (type === "telegram")
        setTelegramUrl((await integrationsApi.telegramLink(ws, channel.id)).url);
    },
    onSuccess: () => {
      setError(null);
      setName("");
      return client.invalidateQueries({ queryKey: ["channels", ws] });
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const hint =
    type === "teams"
      ? t("teamsHint")
      : type === "discord"
        ? t("discordHint")
        : type === "webhook"
          ? t("webhookHint")
          : type === "telegram"
            ? t("telegramHint")
            : type === "email"
              ? t("emailsHint")
              : undefined;

  return (
    <form
      className="grid max-w-xl gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      {error && <Alert tone="error">{error}</Alert>}
      <Field label={t("type")} htmlFor="channel-type">
        <Select
          id="channel-type"
          value={type}
          onChange={(e) => {
            const next = e.target.value as ChannelType;
            setType(next);
            setValue(next === "email" ? email : "");
          }}
        >
          {FORM_TYPES.map((value) => (
            <option key={value} value={value}>
              {t(`types.${value}`)}
            </option>
          ))}
        </Select>
      </Field>
      {type !== "slack" && (
        <Field label={t("name")} htmlFor="channel-name">
          <Input
            id="channel-name"
            value={name}
            placeholder={t(`types.${type}`)}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
      )}
      {(type === "email" || type === "webhook" || type === "discord" || type === "teams") && (
        <Field
          label={type === "email" ? t("emails") : t("url")}
          htmlFor="channel-value"
          hint={hint}
        >
          <Input
            id="channel-value"
            value={value}
            inputMode={type === "email" ? "email" : "url"}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
      )}
      {type === "telegram" && <p className="text-sm text-muted-foreground">{hint}</p>}
      {telegramUrl && (
        <Alert tone="success">
          <a href={telegramUrl} target="_blank" rel="noreferrer" className="underline">
            {t("telegramLink")}
          </a>
        </Alert>
      )}
      <div>
        <Button type="submit" disabled={create.isPending}>
          {type === "slack" ? t("slackConnect") : t("add")}
        </Button>
      </div>
    </form>
  );
}

export function IntegrationsPage() {
  const t = useTranslations("integrations");
  const workspace = useWorkspace();
  const ws = workspace.id;
  const client = useQueryClient();
  const channels = useQuery({
    queryKey: ["channels", ws],
    queryFn: async () => (await integrationsApi.channels(ws)).data,
  });
  const isAdmin = can(workspace.role, "admin");

  return (
    <div className="grid max-w-4xl gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-1 text-muted-foreground">{t("intro")}</p>
      </div>
      <section className="grid gap-2" aria-labelledby="channels-heading">
        <h2 id="channels-heading" className="text-base font-semibold">
          {t("channels")}
        </h2>
        {channels.isPending ? (
          <Loading rows={2} />
        ) : (channels.data ?? []).length === 0 ? (
          <EmptyState title={t("empty")} />
        ) : (
          <ul className="divide-y rounded-lg border">
            {(channels.data ?? []).map((channel) => (
              <li key={channel.id} className="flex flex-wrap items-center gap-3 px-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{channel.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {t(`types.${channel.type}`)} ·{" "}
                    {channel.lastSuccessAt
                      ? `${t("lastSuccess")}: ${relativeTime(channel.lastSuccessAt)}`
                      : t("noDeliveriesYet")}
                  </p>
                  {channel.status !== "healthy" && channel.lastError && (
                    <p className="mt-1 break-words text-xs text-status-down">{channel.lastError}</p>
                  )}
                </div>
                {channel.status === "healthy" ? (
                  <span className="inline-flex items-center gap-1 text-xs text-status-up">
                    <CircleCheck aria-hidden className="size-3.5" />
                    {t("healthy")}
                  </span>
                ) : (
                  <span
                    className="inline-flex items-center gap-1 text-xs text-status-down"
                    title={channel.lastError ?? undefined}
                  >
                    <CircleX aria-hidden className="size-3.5" />
                    {t("failing")}
                  </span>
                )}
                {isAdmin && <SendTestButton ws={ws} channel={channel} />}
                {isAdmin && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`${t("remove")} ${channel.name}`}
                    onClick={async () => {
                      if (!window.confirm(t("confirmRemove", { name: channel.name }))) return;
                      await integrationsApi.removeChannel(ws, channel.id);
                      await client.invalidateQueries({ queryKey: ["channels", ws] });
                    }}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle>{t("add")}</CardTitle>
            <CardDescription>{t("intro")}</CardDescription>
          </CardHeader>
          <CardContent>
            <AddChannelForm ws={ws} email={workspace.user.email} />
          </CardContent>
        </Card>
      )}
      {isAdmin && (channels.data ?? []).length > 0 && <DrillCard ws={ws} />}
    </div>
  );
}
