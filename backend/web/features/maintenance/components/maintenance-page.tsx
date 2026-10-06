/*
 * Maintenance windows: planned work during which the chosen monitors keep being checked but open no
 * incident and send no alert. Lists the windows with what they are doing now, and plans new ones
 * (one-off or repeating daily, weekly or monthly in a timezone).
 */
"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { CreateMaintenanceWindowInput, MaintenanceWindowView } from "@app/shared";
import { can, useWorkspace } from "@/components/app/workspace-context";
import { Alert, EmptyState } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Loading } from "@/components/ui/skeleton";
import { ApiError, api, errorMessage, wsPath } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useMonitors } from "@/features/monitors/hooks";

export const REPEATS = ["none", "daily", "weekly", "monthly"] as const;
export type Repeat = (typeof REPEATS)[number];

const RULE: Record<Repeat, string | null> = {
  none: null,
  daily: "FREQ=DAILY",
  weekly: "FREQ=WEEKLY",
  monthly: "FREQ=MONTHLY",
};

/* The repeat a stored rule stands for; anything richer than the form offers is "custom". */
export function repeatOf(rrule: string | null): Repeat | "custom" {
  if (rrule === null) return "none";
  const match = REPEATS.find((repeat) => RULE[repeat] === rrule);
  return match ?? "custom";
}

export interface WindowForm {
  name: string;
  /* `datetime-local` values, in the browser's own timezone. */
  start: string;
  end: string;
  timezone: string;
  repeat: Repeat;
  allMonitors: boolean;
  monitorIds: string[];
}

/* The API body for the form, or which field stops it. */
export function toWindowBody(
  form: WindowForm,
): { body: CreateMaintenanceWindowInput } | { field: "name" | "start" | "end" | "monitors" } {
  if (form.name.trim() === "") return { field: "name" };
  const start = new Date(form.start);
  const end = new Date(form.end);
  if (Number.isNaN(start.getTime())) return { field: "start" };
  if (Number.isNaN(end.getTime()) || end <= start) return { field: "end" };
  if (!form.allMonitors && form.monitorIds.length === 0) return { field: "monitors" };
  return {
    body: {
      name: form.name.trim(),
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      timezone: form.timezone.trim() || "UTC",
      rrule: RULE[form.repeat],
      scope: form.allMonitors ? { all: true } : { monitorIds: form.monitorIds },
      suppressAlerts: true,
      showOnPages: true,
    },
  };
}

const maintenanceKey = (ws: string) => ["maintenance-windows", ws] as const;

const browserTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

function WindowStatus({ window }: { window: MaintenanceWindowView }) {
  const t = useTranslations("maintenance");
  if (window.active && window.activeUntil !== null) {
    return (
      <span className="font-medium text-status-maintenance">
        {t("activeUntil", { time: formatDateTime(window.activeUntil) })}
      </span>
    );
  }
  if (window.nextStart !== null) {
    return <span>{t("nextStart", { time: formatDateTime(window.nextStart) })}</span>;
  }
  return <span className="text-muted-foreground">{t("over")}</span>;
}

function NewWindow({ ws, onCreated }: { ws: string; onCreated: () => void }) {
  const t = useTranslations("maintenance");
  const tc = useTranslations("common");
  const monitors = useMonitors(ws);
  const [form, setForm] = React.useState<WindowForm>(() => ({
    name: "",
    start: "",
    end: "",
    timezone: browserTimezone(),
    repeat: "none",
    allMonitors: true,
    monitorIds: [],
  }));
  const [problem, setProblem] = React.useState<string | null>(null);
  const set = <K extends keyof WindowForm>(key: K, value: WindowForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const create = useMutation({
    mutationFn: (body: CreateMaintenanceWindowInput) =>
      api<MaintenanceWindowView>(wsPath(ws, "/maintenance-windows"), { method: "POST", body }),
    onSuccess: () => {
      setForm((current) => ({ ...current, name: "", start: "", end: "" }));
      onCreated();
    },
    onError: (err) => {
      const first = err instanceof ApiError ? err.fieldErrors[0] : undefined;
      setProblem(first ? first.message : errorMessage(err));
    },
  });

  function submit() {
    setProblem(null);
    const built = toWindowBody(form);
    if ("field" in built) {
      setProblem(t(`invalid.${built.field}`));
      return;
    }
    create.mutate(built.body);
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
      <Field label={t("name")} htmlFor="mw-name">
        <Input
          id="mw-name"
          value={form.name}
          maxLength={120}
          placeholder={t("namePlaceholder")}
          onChange={(e) => set("name", e.target.value)}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("start")} htmlFor="mw-start" hint={t("timesHint")}>
          <Input
            id="mw-start"
            type="datetime-local"
            value={form.start}
            onChange={(e) => set("start", e.target.value)}
          />
        </Field>
        <Field label={t("end")} htmlFor="mw-end">
          <Input
            id="mw-end"
            type="datetime-local"
            value={form.end}
            onChange={(e) => set("end", e.target.value)}
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("repeat")} htmlFor="mw-repeat">
          <Select
            id="mw-repeat"
            value={form.repeat}
            onChange={(e) => set("repeat", e.target.value as Repeat)}
          >
            {REPEATS.map((repeat) => (
              <option key={repeat} value={repeat}>
                {t(`repeats.${repeat}`)}
              </option>
            ))}
          </Select>
        </Field>
        {form.repeat !== "none" && (
          <Field label={t("timezone")} htmlFor="mw-timezone" hint={t("timezoneHint")}>
            <Input
              id="mw-timezone"
              value={form.timezone}
              spellCheck={false}
              onChange={(e) => set("timezone", e.target.value)}
            />
          </Field>
        )}
      </div>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">{t("monitors")}</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="mw-scope"
            checked={form.allMonitors}
            onChange={() => set("allMonitors", true)}
          />
          {t("allMonitors")}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="mw-scope"
            checked={!form.allMonitors}
            onChange={() => set("allMonitors", false)}
          />
          {t("someMonitors")}
        </label>
        {!form.allMonitors && (
          <div className="grid max-h-56 gap-1.5 overflow-auto rounded-md border p-3">
            {(monitors.data ?? []).map((monitor) => (
              <label key={monitor.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.monitorIds.includes(monitor.id)}
                  onChange={(e) =>
                    set(
                      "monitorIds",
                      e.target.checked
                        ? [...form.monitorIds, monitor.id]
                        : form.monitorIds.filter((id) => id !== monitor.id),
                    )
                  }
                />
                {monitor.name}
              </label>
            ))}
            {monitors.data?.length === 0 && (
              <p className="text-sm text-muted-foreground">{t("noMonitors")}</p>
            )}
          </div>
        )}
      </fieldset>
      <div>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? tc("saving") : t("create")}
        </Button>
      </div>
    </form>
  );
}

export function MaintenancePage() {
  const t = useTranslations("maintenance");
  const workspace = useWorkspace();
  const ws = workspace.id;
  const client = useQueryClient();
  const canPlan = can(workspace.role, "maintenance:write");
  const windows = useQuery({
    queryKey: maintenanceKey(ws),
    queryFn: async () =>
      (await api<{ data: MaintenanceWindowView[] }>(wsPath(ws, "/maintenance-windows"))).data,
    refetchInterval: 30_000,
  });
  const refresh = () => client.invalidateQueries({ queryKey: maintenanceKey(ws) });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api<unknown>(wsPath(ws, `/maintenance-windows/${id}`), { method: "DELETE" }),
    onSuccess: refresh,
  });

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="max-w-2xl text-muted-foreground">{t("intro")}</p>
      </div>
      {remove.isError && <Alert tone="error">{errorMessage(remove.error)}</Alert>}

      <Card>
        <CardHeader>
          <CardTitle>{t("planned")}</CardTitle>
        </CardHeader>
        <CardContent>
          {windows.isPending ? (
            <Loading />
          ) : windows.isError ? (
            <Alert tone="error">{errorMessage(windows.error)}</Alert>
          ) : windows.data.length === 0 ? (
            <EmptyState title={t("empty")}>{t("emptyHint")}</EmptyState>
          ) : (
            <ul className="divide-y">
              {windows.data.map((window) => {
                const repeat = repeatOf(window.rrule);
                return (
                  <li
                    key={window.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    <div className="grid gap-0.5 text-sm">
                      <p className="font-medium">{window.name}</p>
                      <p>
                        <WindowStatus window={window} />
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {repeat === "custom" ? window.rrule : t(`repeats.${repeat}`)}
                        {repeat !== "none" && ` · ${window.timezone}`}
                        {" · "}
                        {"all" in window.scope
                          ? t("allMonitors")
                          : t("monitorCount", { count: window.scope.monitorIds.length })}
                      </p>
                    </div>
                    {canPlan && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={remove.isPending}
                        onClick={() => {
                          if (globalThis.confirm(t("confirmDelete", { name: window.name }))) {
                            remove.mutate(window.id);
                          }
                        }}
                      >
                        {t("delete")}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {canPlan && (
        <Card>
          <CardHeader>
            <CardTitle>{t("new")}</CardTitle>
          </CardHeader>
          <CardContent>
            <NewWindow ws={ws} onCreated={() => void refresh()} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
