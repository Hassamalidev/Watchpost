/*
 * Outgoing webhooks on the Integrations page (PRODUCT.md §6.13): endpoints of the workspace's own
 * that get a signed POST for the events they subscribe to. A new endpoint shows its signing secret
 * once; each endpoint lists its recent deliveries, with a test event and a replay.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  WEBHOOK_EVENT_GROUPS,
  WEBHOOK_EVENT_TYPES,
  createWebhookSchema,
  type CreateWebhookInput,
  type WebhookDeliveryView,
  type WebhookEndpointView,
  type WebhookEndpointWithSecret,
  type WebhookEventPattern,
} from "@app/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyField } from "@/components/ui/copy-field";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Loading } from "@/components/ui/skeleton";
import { api, errorMessage, wsPath } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

const key = (ws: string) => ["webhooks", ws] as const;
const deliveriesKey = (ws: string, id: string) => ["webhooks", ws, id, "deliveries"] as const;
const PATTERNS: readonly WebhookEventPattern[] = [
  ...WEBHOOK_EVENT_GROUPS.filter((group) => group !== "*"),
  ...WEBHOOK_EVENT_TYPES,
];

function Deliveries({
  ws,
  endpoint,
  canManage,
}: {
  ws: string;
  endpoint: WebhookEndpointView;
  canManage: boolean;
}) {
  const t = useTranslations("integrations.webhooks");
  const client = useQueryClient();
  const list = useQuery({
    queryKey: deliveriesKey(ws, endpoint.id),
    queryFn: async () =>
      (
        await api<{ data: WebhookDeliveryView[] }>(
          wsPath(ws, `/webhooks/${endpoint.id}/deliveries?limit=10`),
        )
      ).data,
  });
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: deliveriesKey(ws, endpoint.id) });
    await client.invalidateQueries({ queryKey: key(ws) });
  };
  const test = useMutation({
    mutationFn: () =>
      api<WebhookDeliveryView>(wsPath(ws, `/webhooks/${endpoint.id}/test`), {
        method: "POST",
        body: {},
      }),
    onSuccess: refresh,
  });
  const replay = useMutation({
    mutationFn: (id: string) =>
      api<WebhookDeliveryView>(wsPath(ws, `/webhooks/${endpoint.id}/deliveries/${id}/replay`), {
        method: "POST",
        body: {},
      }),
    onSuccess: refresh,
  });
  const outcome = (d: WebhookDeliveryView) =>
    d.status === "delivered"
      ? t("delivered", { status: d.responseStatus ?? 200 })
      : d.status === "pending"
        ? t("retrying", { attempts: d.attempts })
        : t("failed", { reason: d.error ?? "" });

  return (
    <div className="grid gap-2">
      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={test.isPending}
            onClick={() => test.mutate()}
          >
            {test.isPending ? t("sending") : t("sendTest")}
          </Button>
          {test.data && (
            <span className="text-sm" role="status">
              {outcome(test.data)}
            </span>
          )}
        </div>
      )}
      {test.isError && <Alert tone="error">{errorMessage(test.error)}</Alert>}
      {replay.isError && <Alert tone="error">{errorMessage(replay.error)}</Alert>}
      {list.isLoading ? (
        <Loading rows={2} />
      ) : (list.data ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noDeliveries")}</p>
      ) : (
        <ul className="grid gap-1 text-sm">
          {(list.data ?? []).map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <span className="font-mono text-xs">{d.eventType}</span> ·{" "}
                {formatDateTime(d.createdAt)} · {outcome(d)}
                {d.manual ? ` · ${t("manual")}` : ""}
              </span>
              {canManage && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={replay.isPending}
                  aria-label={t("replayNamed", {
                    type: d.eventType,
                    when: formatDateTime(d.createdAt),
                  })}
                  onClick={() => replay.mutate(d.id)}
                >
                  {t("replay")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EndpointRow({
  ws,
  endpoint,
  canManage,
}: {
  ws: string;
  endpoint: WebhookEndpointView;
  canManage: boolean;
}) {
  const t = useTranslations("integrations.webhooks");
  const tc = useTranslations("common");
  const client = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const refresh = () => client.invalidateQueries({ queryKey: key(ws) });
  const toggle = useMutation({
    mutationFn: () =>
      api<WebhookEndpointView>(wsPath(ws, `/webhooks/${endpoint.id}`), {
        method: "PATCH",
        body: { enabled: !endpoint.enabled },
      }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api<undefined>(wsPath(ws, `/webhooks/${endpoint.id}`), { method: "DELETE" }),
    onSuccess: refresh,
  });
  return (
    <li className="grid gap-3 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">
            {endpoint.name}{" "}
            {!endpoint.enabled && (
              <span className="rounded border px-1.5 py-0.5 text-xs font-normal">{t("off")}</span>
            )}
          </p>
          <p className="truncate text-sm text-muted-foreground">{endpoint.url}</p>
          <p className="text-xs text-muted-foreground">{endpoint.events.join(", ")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? t("hideDeliveries") : t("showDeliveries")}
          </Button>
          {canManage && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={toggle.isPending}
                onClick={() => toggle.mutate()}
              >
                {endpoint.enabled ? t("switchOff") : t("switchOn")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={remove.isPending}
                aria-label={t("deleteNamed", { name: endpoint.name })}
                onClick={() => {
                  if (globalThis.confirm(t("confirmDelete", { name: endpoint.name })))
                    remove.mutate();
                }}
              >
                {tc("delete")}
              </Button>
            </>
          )}
        </div>
      </div>
      {endpoint.disabledReason && (
        <Alert tone="error">{t("disabled", { reason: endpoint.disabledReason })}</Alert>
      )}
      {(toggle.isError || remove.isError) && (
        <Alert tone="error">{errorMessage(toggle.error ?? remove.error)}</Alert>
      )}
      {open && <Deliveries ws={ws} endpoint={endpoint} canManage={canManage} />}
    </li>
  );
}

function NewEndpoint({
  ws,
  onMade,
}: {
  ws: string;
  onMade: (made: WebhookEndpointWithSecret) => void;
}) {
  const t = useTranslations("integrations.webhooks");
  const tc = useTranslations("common");
  const client = useQueryClient();
  const [name, setName] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [events, setEvents] = React.useState<WebhookEventPattern[]>(["incident.*"]);
  const [template, setTemplate] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: CreateWebhookInput) =>
      api<WebhookEndpointWithSecret>(wsPath(ws, "/webhooks"), { method: "POST", body }),
    onSuccess: async (made) => {
      onMade(made);
      setName("");
      setUrl("");
      setTemplate("");
      await client.invalidateQueries({ queryKey: key(ws) });
    },
    onError: (err) => setProblem(errorMessage(err)),
  });

  function submit() {
    setProblem(null);
    const parsed = createWebhookSchema.safeParse({
      name: name.trim(),
      url: url.trim(),
      events,
      bodyTemplate: template.trim() === "" ? null : template.trim(),
    });
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      setProblem(
        field === "name"
          ? t("nameRequired")
          : field === "url"
            ? t("urlInvalid")
            : t("eventsRequired"),
      );
      return;
    }
    create.mutate(parsed.data);
  }

  return (
    <form
      className="grid max-w-xl gap-4 border-t pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {problem && <Alert tone="error">{problem}</Alert>}
      <Field label={t("name")} htmlFor="webhook-name">
        <Input
          id="webhook-name"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label={t("url")} htmlFor="webhook-url" hint={t("urlHint")}>
        <Input
          id="webhook-url"
          type="url"
          value={url}
          placeholder="https://example.com/hooks/monitoring"
          onChange={(e) => setUrl(e.target.value)}
        />
      </Field>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">{t("events")}</legend>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {PATTERNS.map((pattern) => (
            <label key={pattern} className="flex min-h-6 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={events.includes(pattern)}
                onChange={(e) =>
                  setEvents((held) =>
                    e.target.checked ? [...held, pattern] : held.filter((p) => p !== pattern),
                  )
                }
              />
              <span className="font-mono text-xs">{pattern}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <Field label={t("template")} htmlFor="webhook-template" hint={t("templateHint")}>
        <Textarea
          id="webhook-template"
          rows={4}
          className="font-mono text-xs"
          value={template}
          placeholder={'{"text": "{{data.incident.title}} is {{data.incident.status}}"}'}
          onChange={(e) => setTemplate(e.target.value)}
        />
      </Field>
      <div>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? tc("saving") : t("add")}
        </Button>
      </div>
    </form>
  );
}

export function OutgoingWebhooks({ ws, canManage }: { ws: string; canManage: boolean }) {
  const t = useTranslations("integrations.webhooks");
  const endpoints = useQuery({
    queryKey: key(ws),
    queryFn: async () => (await api<{ data: WebhookEndpointView[] }>(wsPath(ws, "/webhooks"))).data,
  });
  /* The endpoint just made: its secret is shown until the page is left, and never again. */
  const [made, setMade] = React.useState<WebhookEndpointWithSecret | null>(null);
  const list = endpoints.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>
          {t("intro")}{" "}
          <Link href="/docs/webhooks" className="font-medium text-brand underline">
            {t("docsLink")}
          </Link>
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {made && (
          <Alert tone="info">
            <div className="grid gap-2">
              <p className="font-medium">{t("madeTitle", { name: made.name })}</p>
              <CopyField label={t("secretLabel")} value={made.secret} />
              <p className="text-sm">{t("secretHint")}</p>
            </div>
          </Alert>
        )}
        {endpoints.isLoading ? (
          <Loading rows={2} />
        ) : endpoints.isError ? (
          <Alert tone="error">{errorMessage(endpoints.error)}</Alert>
        ) : list.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("none")}</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {list.map((endpoint) => (
              <EndpointRow key={endpoint.id} ws={ws} endpoint={endpoint} canManage={canManage} />
            ))}
          </ul>
        )}
        {canManage && <NewEndpoint ws={ws} onMade={setMade} />}
      </CardContent>
    </Card>
  );
}
