/*
 * One status page in the app: its settings and branding, its components (from monitors or set by
 * hand, in the order shown), its incidents and updates, and a live preview of what visitors see.
 * Viewers get the preview and the lists; the forms are for people who may edit pages.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  MANUAL_COMPONENT_STATUSES,
  STATUS_IMPACTS,
  STATUS_INCIDENT_STATUSES,
  STATUS_PAGE_MAX_COMPONENTS,
  type StatusComponentInput,
  type StatusImpact,
  type StatusIncidentStatus,
  type StatusIncidentView,
  type StatusPageView,
} from "@app/shared";
import { can, useWorkspace } from "@/components/app/workspace-context";
import { Alert, EmptyState } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Loading } from "@/components/ui/skeleton";
import { ApiError, errorMessage } from "@/lib/api";
import { workspaceHref } from "@/lib/navigation";
import { useMonitors } from "@/features/monitors/hooks";
import {
  statusPageKeys,
  statusPagesApi,
  useStatusIncidents,
  useStatusPage,
  useStatusPreview,
} from "../api";
import { DomainCard } from "./domain-card";
import { StatusPageView as PublicView, formatUtc } from "./status-page-view";

const firstProblem = (err: unknown) => {
  const first = err instanceof ApiError ? err.fieldErrors[0] : undefined;
  return first ? first.message : errorMessage(err);
};

/* An empty text field means "not set". */
const orNull = (value: string) => (value.trim() === "" ? null : value.trim());

/* Every query about status pages of the workspace is read again (list, page, preview, incidents). */
function useRefresh(ws: string) {
  const client = useQueryClient();
  return React.useCallback(async () => {
    await client.invalidateQueries({ queryKey: statusPageKeys.all(ws) });
  }, [client, ws]);
}

function SettingsForm({ ws, page }: { ws: string; page: StatusPageView }) {
  const t = useTranslations("statusPages");
  const tc = useTranslations("common");
  const refresh = useRefresh(ws);
  const [form, setForm] = React.useState(() => ({
    name: page.name,
    slug: page.slug,
    description: page.branding.description ?? "",
    logoUrl: page.branding.logoUrl ?? "",
    faviconUrl: page.branding.faviconUrl ?? "",
    accentColor: page.branding.accentColor ?? "",
    supportUrl: page.branding.supportUrl ?? "",
    showUptime: page.settings.showUptime,
    published: page.published,
  }));
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const save = useMutation({
    mutationFn: () =>
      statusPagesApi.update(ws, page.id, {
        name: form.name.trim(),
        slug: form.slug.trim().toLowerCase(),
        published: form.published,
        branding: {
          description: orNull(form.description),
          logoUrl: orNull(form.logoUrl),
          faviconUrl: orNull(form.faviconUrl),
          accentColor: orNull(form.accentColor),
          supportUrl: orNull(form.supportUrl),
        },
        settings: { ...page.settings, showUptime: form.showUptime },
      }),
    onSuccess: refresh,
  });

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      {save.isError && <Alert tone="error">{firstProblem(save.error)}</Alert>}
      {save.isSuccess && <Alert tone="success">{t("saved")}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("name")} htmlFor="spe-name">
          <Input
            id="spe-name"
            value={form.name}
            maxLength={120}
            onChange={(e) => set("name", e.target.value)}
          />
        </Field>
        <Field label={t("address")} htmlFor="spe-slug" hint={t("addressChangeHint")}>
          <Input
            id="spe-slug"
            value={form.slug}
            maxLength={63}
            spellCheck={false}
            autoCapitalize="none"
            onChange={(e) => set("slug", e.target.value)}
          />
        </Field>
      </div>
      <Field label={t("description")} htmlFor="spe-description" hint={t("descriptionHint")}>
        <Input
          id="spe-description"
          value={form.description}
          maxLength={300}
          onChange={(e) => set("description", e.target.value)}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("logoUrl")} htmlFor="spe-logo" hint={t("httpsHint")}>
          <Input
            id="spe-logo"
            type="url"
            value={form.logoUrl}
            placeholder="https://"
            onChange={(e) => set("logoUrl", e.target.value)}
          />
        </Field>
        <Field label={t("faviconUrl")} htmlFor="spe-favicon">
          <Input
            id="spe-favicon"
            type="url"
            value={form.faviconUrl}
            placeholder="https://"
            onChange={(e) => set("faviconUrl", e.target.value)}
          />
        </Field>
        <Field label={t("accentColor")} htmlFor="spe-accent" hint={t("accentHint")}>
          <Input
            id="spe-accent"
            value={form.accentColor}
            placeholder="#2563eb"
            maxLength={7}
            spellCheck={false}
            onChange={(e) => set("accentColor", e.target.value)}
          />
        </Field>
        <Field label={t("supportUrl")} htmlFor="spe-support">
          <Input
            id="spe-support"
            type="url"
            value={form.supportUrl}
            placeholder="https://"
            onChange={(e) => set("supportUrl", e.target.value)}
          />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.showUptime}
          onChange={(e) => set("showUptime", e.target.checked)}
        />
        {t("showUptime")}
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={form.published}
          onChange={(e) => set("published", e.target.checked)}
        />
        <span>
          {t("published")}
          <span className="block text-xs text-muted-foreground">{t("publishedHint")}</span>
        </span>
      </label>
      <div>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? tc("saving") : tc("save")}
        </Button>
      </div>
    </form>
  );
}

interface Row {
  /* A local key for React; the component's own ID once it has one. */
  key: string;
  id?: string;
  name: string;
  monitorId: string;
  manualStatus: (typeof MANUAL_COMPONENT_STATUSES)[number];
  group: string;
}

const rowsOf = (page: StatusPageView): Row[] =>
  page.components.map((c) => ({
    key: c.id,
    id: c.id,
    name: c.name,
    monitorId: c.monitorId ?? "",
    manualStatus: c.manualStatus ?? "operational",
    group: c.group ?? "",
  }));

function ComponentsForm({ ws, page }: { ws: string; page: StatusPageView }) {
  const t = useTranslations("statusPages");
  const ts = useTranslations("statusPage");
  const tc = useTranslations("common");
  const refresh = useRefresh(ws);
  const monitors = useMonitors(ws);
  const [rows, setRows] = React.useState<Row[]>(() => rowsOf(page));
  const nextKey = React.useRef(0);
  const patch = (key: string, change: Partial<Row>) =>
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...change } : r)));
  const move = (index: number, by: -1 | 1) =>
    setRows((current) => {
      const target = index + by;
      if (target < 0 || target >= current.length) return current;
      const copy = [...current];
      const [row] = copy.splice(index, 1);
      if (row) copy.splice(target, 0, row);
      return copy;
    });

  const save = useMutation({
    mutationFn: () =>
      statusPagesApi.replaceComponents(
        ws,
        page.id,
        rows.map((r): StatusComponentInput => ({
          ...(r.id === undefined ? {} : { id: r.id }),
          name: r.name.trim(),
          description: null,
          monitorId: r.monitorId === "" ? null : r.monitorId,
          manualStatus: r.monitorId === "" ? r.manualStatus : null,
          group: orNull(r.group),
          showUptime: true,
        })),
      ),
    onSuccess: async (saved) => {
      setRows(rowsOf(saved));
      await refresh();
    },
  });

  return (
    <div className="grid gap-4">
      {save.isError && <Alert tone="error">{firstProblem(save.error)}</Alert>}
      {save.isSuccess && <Alert tone="success">{t("saved")}</Alert>}
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noComponents")}</p>
      ) : (
        <ol className="grid gap-3">
          {rows.map((row, index) => (
            <li key={row.key} className="grid gap-3 rounded-md border p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("componentName")} htmlFor={`spc-name-${row.key}`}>
                  <Input
                    id={`spc-name-${row.key}`}
                    value={row.name}
                    maxLength={120}
                    onChange={(e) => patch(row.key, { name: e.target.value })}
                  />
                </Field>
                <Field label={t("componentSource")} htmlFor={`spc-source-${row.key}`}>
                  <Select
                    id={`spc-source-${row.key}`}
                    value={row.monitorId}
                    onChange={(e) => patch(row.key, { monitorId: e.target.value })}
                  >
                    <option value="">{t("setByHand")}</option>
                    {(monitors.data ?? []).map((m) => (
                      <option key={m.id} value={m.id}>
                        {t("followsMonitor", { name: m.name })}
                      </option>
                    ))}
                  </Select>
                </Field>
                {row.monitorId === "" && (
                  <Field label={t("componentStatus")} htmlFor={`spc-status-${row.key}`}>
                    <Select
                      id={`spc-status-${row.key}`}
                      value={row.manualStatus}
                      onChange={(e) =>
                        patch(row.key, { manualStatus: e.target.value as Row["manualStatus"] })
                      }
                    >
                      {MANUAL_COMPONENT_STATUSES.map((status) => (
                        <option key={status} value={status}>
                          {ts(`component.${status}`)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
                <Field label={t("componentGroup")} htmlFor={`spc-group-${row.key}`}>
                  <Input
                    id={`spc-group-${row.key}`}
                    value={row.group}
                    maxLength={80}
                    placeholder={t("componentGroupPlaceholder")}
                    onChange={(e) => patch(row.key, { group: e.target.value })}
                  />
                </Field>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={index === 0}
                  aria-label={t("moveUp", { name: row.name })}
                  onClick={() => move(index, -1)}
                >
                  {t("up")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={index === rows.length - 1}
                  aria-label={t("moveDown", { name: row.name })}
                  onClick={() => move(index, 1)}
                >
                  {t("down")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={t("removeComponent", { name: row.name })}
                  onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                >
                  {t("remove")}
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={rows.length >= STATUS_PAGE_MAX_COMPONENTS}
          onClick={() => {
            nextKey.current += 1;
            setRows((current) => [
              ...current,
              {
                key: `new-${nextKey.current}`,
                name: "",
                monitorId: "",
                manualStatus: "operational",
                group: "",
              },
            ]);
          }}
        >
          {t("addComponent")}
        </Button>
        <Button type="button" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? tc("saving") : t("saveComponents")}
        </Button>
      </div>
    </div>
  );
}

function NewIncident({ ws, page }: { ws: string; page: StatusPageView }) {
  const t = useTranslations("statusPages");
  const ts = useTranslations("statusPage");
  const tc = useTranslations("common");
  const refresh = useRefresh(ws);
  const [title, setTitle] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [impact, setImpact] = React.useState<StatusImpact>("partial_outage");
  const [componentIds, setComponentIds] = React.useState<string[]>([]);
  const [problem, setProblem] = React.useState<string | null>(null);

  const create = useMutation({
    mutationFn: (published: boolean) =>
      statusPagesApi.createIncident(ws, page.id, {
        title: title.trim(),
        message: message.trim(),
        impact,
        componentIds,
        published,
      }),
    onSuccess: async () => {
      setTitle("");
      setMessage("");
      setComponentIds([]);
      await refresh();
    },
    onError: (err) => setProblem(firstProblem(err)),
  });

  function submit(published: boolean) {
    setProblem(null);
    if (title.trim() === "" || message.trim() === "") {
      setProblem(t("incidentIncomplete"));
      return;
    }
    create.mutate(published);
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit(true);
      }}
    >
      {problem && <Alert tone="error">{problem}</Alert>}
      <Field label={t("incidentTitle")} htmlFor="spi-title">
        <Input
          id="spi-title"
          value={title}
          maxLength={200}
          placeholder={t("incidentTitlePlaceholder")}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <Field label={t("incidentMessage")} htmlFor="spi-message" hint={t("incidentMessageHint")}>
        <Textarea
          id="spi-message"
          rows={3}
          value={message}
          maxLength={5_000}
          onChange={(e) => setMessage(e.target.value)}
        />
      </Field>
      <Field label={t("impact")} htmlFor="spi-impact">
        <Select
          id="spi-impact"
          value={impact}
          onChange={(e) => setImpact(e.target.value as StatusImpact)}
        >
          {STATUS_IMPACTS.map((value) => (
            <option key={value} value={value}>
              {ts(`component.${value}`)}
            </option>
          ))}
        </Select>
      </Field>
      {page.components.length > 0 && (
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">{t("affected")}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {page.components.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={componentIds.includes(c.id)}
                  onChange={(e) =>
                    setComponentIds((current) =>
                      e.target.checked ? [...current, c.id] : current.filter((id) => id !== c.id),
                    )
                  }
                />
                {c.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? tc("saving") : t("publishIncident")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={create.isPending}
          onClick={() => submit(false)}
        >
          {t("saveDraft")}
        </Button>
      </div>
    </form>
  );
}

function IncidentItem({
  ws,
  page,
  incident,
  canEdit,
}: {
  ws: string;
  page: StatusPageView;
  incident: StatusIncidentView;
  canEdit: boolean;
}) {
  const t = useTranslations("statusPages");
  const ts = useTranslations("statusPage");
  const refresh = useRefresh(ws);
  const next = (current: StatusIncidentStatus): StatusIncidentStatus =>
    STATUS_INCIDENT_STATUSES[
      Math.min(STATUS_INCIDENT_STATUSES.indexOf(current) + 1, STATUS_INCIDENT_STATUSES.length - 1)
    ] ?? "resolved";
  const [status, setStatus] = React.useState<StatusIncidentStatus>(() => next(incident.status));
  const [message, setMessage] = React.useState("");
  const fieldId = `spu-${incident.id}`;

  const act = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: async () => {
      setMessage("");
      await refresh();
    },
  });

  return (
    <li className="grid gap-3 rounded-md border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">{incident.title}</p>
          <p className="text-sm text-muted-foreground">
            {ts(`incident.${incident.status}`)} · {formatUtc(incident.startedAt)}
            {!incident.published && ` · ${t("draft")}`}
            {incident.auto && ` · ${t("automatic")}`}
          </p>
        </div>
        {canEdit && (
          <div className="flex gap-2">
            {!incident.published && (
              <Button
                size="sm"
                disabled={act.isPending}
                onClick={() =>
                  act.mutate(() => statusPagesApi.publishIncident(ws, page.id, incident.id))
                }
              >
                {t("publish")}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={act.isPending}
              onClick={() => {
                if (globalThis.confirm(t("confirmDeleteIncident", { title: incident.title }))) {
                  act.mutate(() => statusPagesApi.removeIncident(ws, page.id, incident.id));
                }
              }}
            >
              {t("deleteIncident")}
            </Button>
          </div>
        )}
      </div>
      {act.isError && <Alert tone="error">{firstProblem(act.error)}</Alert>}
      <p className="whitespace-pre-wrap text-sm">{incident.updates[0]?.message}</p>
      {canEdit && (
        <form
          className="grid gap-3 sm:grid-cols-[12rem_1fr_auto] sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            if (message.trim() === "") return;
            act.mutate(() =>
              statusPagesApi.postUpdate(ws, page.id, incident.id, {
                status,
                message: message.trim(),
              }),
            );
          }}
        >
          <Field label={t("updateStatus")} htmlFor={`${fieldId}-status`}>
            <Select
              id={`${fieldId}-status`}
              value={status}
              onChange={(e) => setStatus(e.target.value as StatusIncidentStatus)}
            >
              {STATUS_INCIDENT_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {ts(`incident.${value}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("updateMessage")} htmlFor={`${fieldId}-message`}>
            <Input
              id={`${fieldId}-message`}
              value={message}
              maxLength={5_000}
              onChange={(e) => setMessage(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="outline" disabled={act.isPending}>
            {t("postUpdate")}
          </Button>
        </form>
      )}
    </li>
  );
}

export function StatusPageEditor({ id }: { id: string }) {
  const t = useTranslations("statusPages");
  const router = useRouter();
  const { id: ws, role } = useWorkspace();
  const canEdit = can(role, "statusPage:write");
  const page = useStatusPage(ws, id);
  const preview = useStatusPreview(ws, id);
  const incidents = useStatusIncidents(ws, id);
  const client = useQueryClient();

  const remove = useMutation({
    mutationFn: () => statusPagesApi.remove(ws, id),
    onSuccess: async () => {
      client.removeQueries({ queryKey: statusPageKeys.one(ws, id) });
      await client.invalidateQueries({ queryKey: statusPageKeys.all(ws) });
      router.push(workspaceHref(ws, "status-pages"));
    },
  });

  if (page.isLoading) return <Loading />;
  if (page.isError || page.data === undefined) {
    return <Alert tone="error">{errorMessage(page.error)}</Alert>;
  }
  const data = page.data;
  const open = (incidents.data ?? []).filter((i) => i.resolvedAt === null);
  const past = (incidents.data ?? []).filter((i) => i.resolvedAt !== null).slice(0, 5);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href={workspaceHref(ws, "status-pages")}
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            {t("backToList")}
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">{data.name}</h1>
          <p className="text-sm text-muted-foreground">
            {data.published ? (
              <a
                href={data.url}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-4"
              >
                {data.url}
              </a>
            ) : (
              t("unpublished")
            )}
          </p>
        </div>
        {canEdit && (
          <Button
            variant="outline"
            disabled={remove.isPending}
            onClick={() => {
              if (globalThis.confirm(t("confirmDelete", { name: data.name }))) remove.mutate();
            }}
          >
            {t("deletePage")}
          </Button>
        )}
      </div>
      {remove.isError && <Alert tone="error">{errorMessage(remove.error)}</Alert>}

      <div className="grid gap-6 xl:grid-cols-2">
        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t("incidents")}</CardTitle>
              <CardDescription>{t("incidentsHint")}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {incidents.isLoading ? (
                <Loading rows={2} />
              ) : open.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("noOpenIncidents")}</p>
              ) : (
                <ul className="grid gap-3">
                  {open.map((incident) => (
                    <IncidentItem
                      key={incident.id}
                      ws={ws}
                      page={data}
                      incident={incident}
                      canEdit={canEdit}
                    />
                  ))}
                </ul>
              )}
              {canEdit && (
                <details className="rounded-md border p-3" open={open.length === 0}>
                  <summary className="cursor-pointer text-sm font-medium">
                    {t("newIncident")}
                  </summary>
                  <div className="mt-4">
                    <NewIncident ws={ws} page={data} />
                  </div>
                </details>
              )}
              {past.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium">{t("pastIncidents")}</h3>
                  <ul className="mt-2 grid gap-3">
                    {past.map((incident) => (
                      <IncidentItem
                        key={incident.id}
                        ws={ws}
                        page={data}
                        incident={incident}
                        canEdit={canEdit}
                      />
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>

          {canEdit && (
            <Card>
              <CardHeader>
                <CardTitle>{t("components")}</CardTitle>
                <CardDescription>{t("componentsHint")}</CardDescription>
              </CardHeader>
              <CardContent>
                <ComponentsForm ws={ws} page={data} />
              </CardContent>
            </Card>
          )}

          {canEdit && (
            <Card>
              <CardHeader>
                <CardTitle>{t("settings")}</CardTitle>
              </CardHeader>
              <CardContent>
                <SettingsForm ws={ws} page={data} />
              </CardContent>
            </Card>
          )}

          {canEdit && (
            <Card>
              <CardHeader>
                <CardTitle>{t("domain.title")}</CardTitle>
                <CardDescription>{t("domain.intro")}</CardDescription>
              </CardHeader>
              <CardContent>
                <DomainCard ws={ws} page={data} />
              </CardContent>
            </Card>
          )}
        </div>

        <Card className="content-start">
          <CardHeader>
            <CardTitle>{t("preview")}</CardTitle>
            <CardDescription>{t("previewHint")}</CardDescription>
          </CardHeader>
          <CardContent>
            {preview.isLoading ? (
              <Loading />
            ) : preview.data === undefined ? (
              <EmptyState title={t("previewUnavailable")} />
            ) : (
              <div
                data-testid="status-preview"
                className="overflow-hidden rounded-md border bg-background [&>div]:min-h-0 [&>div]:py-6"
              >
                <PublicView data={preview.data} embedded />
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
