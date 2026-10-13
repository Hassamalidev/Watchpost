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
import { Disclosure } from "@/components/ui/disclosure";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Loading } from "@/components/ui/skeleton";
import { api, errorMessage, wsPath } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

const key = (ws: string) => ["webhooks", ws] as const;
const deliveriesKey = (ws: string, id: string) => ["webhooks", ws, id, "deliveries"] as const;

/* The workspace's webhook endpoints; the page header counts them and this section lists them. */
export function useWebhookEndpoints(ws: string) {
  return useQuery({
    queryKey: key(ws),
    queryFn: async () => (await api<{ data: WebhookEndpointView[] }>(wsPath(ws, "/webhooks"))).data,
  });
}
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
  onSecret,
}: {
  ws: string;
  endpoint: WebhookEndpointView;
  canManage: boolean;
  /* A new signing secret was made; it is shown once, like a new endpoint's. */
  onSecret: (made: WebhookEndpointWithSecret) => void;
}) {
  const t = useTranslations("integrations.webhooks");
  const tc = useTranslations("common");
  const client = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const rotate = useMutation({
    mutationFn: () =>
      api<WebhookEndpointWithSecret>(wsPath(ws, `/webhooks/${endpoint.id}/secret`), {
        method: "POST",
        body: {},
      }),
    onSuccess: onSecret,
  });
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
          <p className="font-medium break-words">
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
                aria-expanded={editing}
                aria-label={t("editNamed", { name: endpoint.name })}
                onClick={() => setEditing(!editing)}
              >
                {t("edit")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={rotate.isPending}
                aria-label={t("newSecretNamed", { name: endpoint.name })}
                onClick={() => {
                  if (globalThis.confirm(t("confirmNewSecret", { name: endpoint.name })))
                    rotate.mutate();
                }}
              >
                {t("newSecret")}
              </Button>
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
      {(toggle.isError || remove.isError || rotate.isError) && (
        <Alert tone="error">{errorMessage(toggle.error ?? remove.error ?? rotate.error)}</Alert>
      )}
      {editing && <EndpointForm ws={ws} endpoint={endpoint} onDone={() => setEditing(false)} />}
      {open && <Deliveries ws={ws} endpoint={endpoint} canManage={canManage} />}
    </li>
  );
}

/* One form for a new endpoint and for changing one: name, address, events and the body template. */
function EndpointForm({
  ws,
  endpoint,
  onMade,
  onDone,
}: {
  ws: string;
  /* Set when editing. */
  endpoint?: WebhookEndpointView;
  /* A new endpoint was created; its secret is in the answer. */
  onMade?: (made: WebhookEndpointWithSecret) => void;
  /* Editing ended (saved or cancelled). */
  onDone?: () => void;
}) {
  const t = useTranslations("integrations.webhooks");
  const tc = useTranslations("common");
  const client = useQueryClient();
  const [name, setName] = React.useState(endpoint?.name ?? "");
  const [url, setUrl] = React.useState(endpoint?.url ?? "");
  const [events, setEvents] = React.useState<WebhookEventPattern[]>(
    endpoint?.events ?? ["incident.*"],
  );
  const [template, setTemplate] = React.useState(endpoint?.bodyTemplate ?? "");
  const [problem, setProblem] = React.useState<string | null>(null);
  const prefix = endpoint ? `webhook-${endpoint.id}` : "webhook";
  const save = useMutation({
    mutationFn: (body: CreateWebhookInput) =>
      endpoint
        ? api<WebhookEndpointView>(wsPath(ws, `/webhooks/${endpoint.id}`), {
            method: "PATCH",
            body: {
              name: body.name,
              /* An unchanged address isn't sent: changing it has rules of its own. */
              ...(body.url === endpoint.url ? {} : { url: body.url }),
              events: body.events,
              bodyTemplate: body.bodyTemplate,
            },
          })
        : api<WebhookEndpointWithSecret>(wsPath(ws, "/webhooks"), { method: "POST", body }),
    onSuccess: async (saved) => {
      if (endpoint === undefined) {
        onMade?.(saved as WebhookEndpointWithSecret);
        setName("");
        setUrl("");
        setTemplate("");
      }
      await client.invalidateQueries({ queryKey: key(ws) });
      onDone?.();
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
            : field === "bodyTemplate"
              ? t("templateInvalid")
              : t("eventsRequired"),
      );
      return;
    }
    save.mutate(parsed.data);
  }

  return (
    <form
      className="grid max-w-xl gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {problem && <Alert tone="error">{problem}</Alert>}
      <Field label={t("name")} htmlFor={`${prefix}-name`}>
        <Input
          id={`${prefix}-name`}
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label={t("url")} htmlFor={`${prefix}-url`} hint={t("urlHint")}>
        <Input
          id={`${prefix}-url`}
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
      <Field label={t("template")} htmlFor={`${prefix}-template`} hint={t("templateHint")}>
        <Textarea
          id={`${prefix}-template`}
          rows={4}
          className="font-mono text-xs"
          value={template}
          placeholder={'{"text": "{{data.incident.title}} is {{data.incident.status}}"}'}
          onChange={(e) => setTemplate(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? tc("saving") : endpoint ? tc("save") : t("add")}
        </Button>
        {endpoint && (
          <Button type="button" variant="outline" onClick={() => onDone?.()}>
            {tc("cancel")}
          </Button>
        )}
      </div>
    </form>
  );
}

export function OutgoingWebhooks({ ws, canManage }: { ws: string; canManage: boolean }) {
  const t = useTranslations("integrations.webhooks");
  const endpoints = useWebhookEndpoints(ws);
  /* The endpoint just made or re-keyed: its secret is shown until the page is left, and never again. */
  const [made, setMade] = React.useState<{
    endpoint: WebhookEndpointWithSecret;
    rotated: boolean;
  } | null>(null);
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
              <p className="font-medium">
                {t(made.rotated ? "rotatedTitle" : "madeTitle", { name: made.endpoint.name })}
              </p>
              <CopyField label={t("secretLabel")} value={made.endpoint.secret} />
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
              <EndpointRow
                key={endpoint.id}
                ws={ws}
                endpoint={endpoint}
                canManage={canManage}
                onSecret={(secret) => setMade({ endpoint: secret, rotated: true })}
              />
            ))}
          </ul>
        )}
        {/* Shown once the list is known: open when there is nothing yet, folded after that. */}
        {canManage && !endpoints.isLoading && (
          <Disclosure
            summary={t("addTitle")}
            hint={t("addHint")}
            bordered={false}
            className="border-t pt-3"
            defaultOpen={list.length === 0}
          >
            <EndpointForm ws={ws} onMade={(endpoint) => setMade({ endpoint, rotated: false })} />
          </Disclosure>
        )}
      </CardContent>
    </Card>
  );
}
