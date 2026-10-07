/* Workspace settings: time zone for schedules, reports and dates (admins change it). */
"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { CheckRegions } from "./check-regions";
import { can, useWorkspace } from "@/components/app/workspace-context";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/input";
import Link from "next/link";
import { api, errorMessage, wsPath } from "@/lib/api";
import { workspaceHref } from "@/lib/navigation";

const ZONES: string[] =
  typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["UTC"];

export function SettingsPage() {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const workspace = useWorkspace();
  const ws = workspace.id;
  const client = useQueryClient();
  const settings = useQuery({
    queryKey: ["settings", ws],
    queryFn: () => api<{ timezone: string }>(wsPath(ws, "/settings")),
  });
  const [timezone, setTimezone] = React.useState<string | null>(null);
  const save = useMutation({
    mutationFn: (tz: string) =>
      api(wsPath(ws, "/settings"), { method: "PATCH", body: { timezone: tz } }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["settings", ws] }),
  });
  const current = timezone ?? settings.data?.timezone ?? "UTC";
  const zones = ZONES.includes(current) ? ZONES : [current, ...ZONES];

  return (
    <div className="grid max-w-xl gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(current);
        }}
      >
        {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
        {save.isSuccess && <Alert tone="success">{t("saved")}</Alert>}
        <Field label={t("timezone")} htmlFor="settings-tz" hint={t("timezoneHint")}>
          <Select
            id="settings-tz"
            value={current}
            disabled={!can(workspace.role, "settings:update")}
            onChange={(e) => setTimezone(e.target.value)}
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </Select>
        </Field>
        {can(workspace.role, "settings:update") && (
          <div>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? tc("saving") : tc("save")}
            </Button>
          </div>
        )}
      </form>
      <CheckRegions ws={ws} />
      {can(workspace.role, "settings:update") && (
        <section className="grid gap-2 rounded-lg border p-4" aria-labelledby="import-heading">
          <h2 id="import-heading" className="text-base font-semibold">
            {t("importTitle")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("importHint")}</p>
          <div>
            <Link
              href={`${workspaceHref(ws, "settings")}/import`}
              className="text-sm font-medium text-brand underline"
            >
              {t("importLink")}
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}
