/*
 * Inbound alerts on the Integrations page: token URLs that other tools (Alertmanager, Grafana,
 * Datadog, anything that can post JSON, or email) send their alerts to. A new source shows its URL
 * once; the tester shows what a payload would do without opening an incident.
 */
"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  DATADOG_PAYLOAD_TEMPLATE,
  INBOUND_KINDS,
  INBOUND_KIND_LABELS,
  INBOUND_SAMPLES,
  type InboundEvent,
  type InboundKind,
  type InboundSourceView,
} from "@app/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyField } from "@/components/ui/copy-field";
import { Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Loading } from "@/components/ui/skeleton";
import { api, errorMessage, wsPath } from "@/lib/api";
import { relativeTime } from "@/lib/format";

type Created = InboundSourceView & { url: string };
const key = (ws: string) => ["inbound-sources", ws] as const;

function Tester({ ws, source }: { ws: string; source: InboundSourceView }) {
  const t = useTranslations("integrations.inbound");
  const tMonitors = useTranslations("monitors");
  const sample = (which: "trigger" | "resolve") =>
    JSON.stringify(INBOUND_SAMPLES[source.kind][which], null, 2);
  const [text, setText] = React.useState(() => sample("trigger"));
  const [problem, setProblem] = React.useState<string | undefined>();
  const check = useMutation({
    mutationFn: (payload: unknown) =>
      api<{ data: InboundEvent[] }>(wsPath(ws, `/inbound-sources/${source.id}/test`), {
        method: "POST",
        body: { payload },
      }),
  });
  const inputId = `inbound-payload-${source.id}`;

  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch {
          setProblem(t("notJson"));
          check.reset();
          return;
        }
        setProblem(undefined);
        check.mutate(payload);
      }}
    >
      <Field label={t("payload")} htmlFor={inputId} hint={t("payloadHint")}>
        <Textarea
          id={inputId}
          rows={8}
          className="font-mono text-xs"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={check.isPending}>
          {t("check")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setText(sample("trigger"))}
        >
          {t("sampleTrigger")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setText(sample("resolve"))}
        >
          {t("sampleResolve")}
        </Button>
      </div>
      {(problem ?? (check.isError ? errorMessage(check.error) : undefined)) !== undefined && (
        <Alert tone="error">{problem ?? errorMessage(check.error)}</Alert>
      )}
      {check.data !== undefined && (
        <ul className="grid gap-1 text-sm" aria-label={t("result")}>
          {check.data.data.map((event, index) => (
            <li key={index} className="rounded-md border px-3 py-2">
              {event.status === "trigger"
                ? t("wouldOpen", {
                    title: event.title,
                    severity: tMonitors(`severities.${event.severity}`),
                  })
                : t("wouldResolve", { title: event.title })}
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

export function InboundSources({ ws, canManage }: { ws: string; canManage: boolean }) {
  const t = useTranslations("integrations.inbound");
  const client = useQueryClient();
  const [name, setName] = React.useState("");
  const [kind, setKind] = React.useState<InboundKind>("generic");
  const [shown, setShown] = React.useState<Created | undefined>();
  const [testing, setTesting] = React.useState<string | undefined>();
  const sources = useQuery({
    queryKey: key(ws),
    queryFn: async () =>
      (await api<{ data: InboundSourceView[] }>(wsPath(ws, "/inbound-sources"))).data,
  });
  const refresh = () => client.invalidateQueries({ queryKey: key(ws) });
  const create = useMutation({
    mutationFn: () =>
      api<Created>(wsPath(ws, "/inbound-sources"), {
        method: "POST",
        body: { name: name.trim(), kind },
      }),
    onSuccess: async (created) => {
      setShown(created);
      setName("");
      await refresh();
    },
  });
  const rotate = useMutation({
    mutationFn: (id: string) =>
      api<Created>(wsPath(ws, `/inbound-sources/${id}/rotate`), { method: "POST" }),
    onSuccess: async (created) => {
      setShown(created);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(wsPath(ws, `/inbound-sources/${id}`), { method: "DELETE" }),
    onSuccess: async (_data, id) => {
      if (shown?.id === id) setShown(undefined);
      await refresh();
    },
  });
  const list = sources.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-sm text-muted-foreground">{t("hint")}</p>
        {sources.isError && <Alert tone="error">{errorMessage(sources.error)}</Alert>}
        {(rotate.isError || remove.isError) && (
          <Alert tone="error">{errorMessage(rotate.error ?? remove.error)}</Alert>
        )}

        {shown !== undefined && (
          <div className="grid gap-2 rounded-lg border p-3">
            <CopyField label={t("url", { name: shown.name })} value={shown.url} />
            <p className="text-sm text-muted-foreground">{t("shownOnce")}</p>
            <p className="text-sm">{t(`setup.${shown.kind}`)}</p>
            {shown.kind === "datadog" && (
              <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
                {DATADOG_PAYLOAD_TEMPLATE}
              </pre>
            )}
          </div>
        )}

        {sources.isPending ? (
          <Loading rows={1} />
        ) : list.length === 0 ? (
          <p className="text-sm">{t("empty")}</p>
        ) : (
          <ul className="divide-y rounded-lg border" aria-label={t("title")}>
            {list.map((source) => (
              <li key={source.id} className="grid gap-3 px-3 py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{source.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {INBOUND_KIND_LABELS[source.kind]} · {source.tokenHint}… ·{" "}
                      {source.lastReceivedAt === null
                        ? t("never")
                        : t("lastReceived", { when: relativeTime(source.lastReceivedAt) })}
                    </p>
                  </div>
                  {canManage && (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-expanded={testing === source.id}
                        onClick={() => setTesting(testing === source.id ? undefined : source.id)}
                      >
                        {t("tryPayload")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={rotate.isPending}
                        onClick={() => rotate.mutate(source.id)}
                      >
                        {t("newUrl")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={remove.isPending}
                        aria-label={t("deleteNamed", { name: source.name })}
                        onClick={() => remove.mutate(source.id)}
                      >
                        {t("delete")}
                      </Button>
                    </>
                  )}
                </div>
                {testing === source.id && <Tester ws={ws} source={source} />}
              </li>
            ))}
          </ul>
        )}

        {canManage && (
          <form
            className="grid gap-3 sm:grid-cols-[1fr_14rem_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() !== "") create.mutate();
            }}
          >
            <Field label={t("name")} htmlFor="inbound-name">
              <Input
                id="inbound-name"
                value={name}
                maxLength={80}
                placeholder={t("namePlaceholder")}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </Field>
            <Field label={t("kind")} htmlFor="inbound-kind">
              <Select
                id="inbound-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as InboundKind)}
              >
                {INBOUND_KINDS.map((option) => (
                  <option key={option} value={option}>
                    {INBOUND_KIND_LABELS[option]}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit" disabled={create.isPending}>
              {t("add")}
            </Button>
            {create.isError && (
              <div className="sm:col-span-3">
                <Alert tone="error">{errorMessage(create.error)}</Alert>
              </div>
            )}
          </form>
        )}
      </CardContent>
    </Card>
  );
}
