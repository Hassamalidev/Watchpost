/*
 * Workspace settings. The time zone, which everyone needs, is in view; everything else is a folded
 * section that opens when wanted.
 */
"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ApiKeys } from "./api-keys";
import { CheckRegions } from "./check-regions";
import { ClientWorkspaces } from "./client-workspaces";
import { RequireTwoFactor } from "./require-two-factor";
import { PrivateProbes } from "./private-probes";
import { WorkspaceData } from "./workspace-data";
import { can, useWorkspace } from "@/components/app/workspace-context";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
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
  const isAdmin = can(workspace.role, "settings:update");
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
      {/*
       * The rest is used rarely, or by the technical few. Each section is one line until opened, so
       * the page reads as a short list instead of nine forms.
       */}
      <section className="grid gap-2" aria-labelledby="more-settings-heading">
        <h2 id="more-settings-heading" className="text-sm font-medium text-muted-foreground">
          {t("more")}
        </h2>
        {isAdmin && (
          <Disclosure summary={t("sections.security")} hint={t("sections.securityHint")}>
            <RequireTwoFactor ws={ws} />
          </Disclosure>
        )}
        {isAdmin && workspace.parent == null && (
          <Disclosure summary={t("sections.clients")} hint={t("sections.clientsHint")}>
            <ClientWorkspaces ws={ws} />
          </Disclosure>
        )}
        <Disclosure summary={t("sections.regions")} hint={t("sections.regionsHint")}>
          <CheckRegions ws={ws} />
        </Disclosure>
        <Disclosure summary={t("sections.probes")} hint={t("sections.probesHint")}>
          <PrivateProbes ws={ws} canManage={isAdmin} />
        </Disclosure>
        {isAdmin && (
          <Disclosure summary={t("sections.apiKeys")} hint={t("sections.apiKeysHint")}>
            <ApiKeys ws={ws} />
          </Disclosure>
        )}
        {isAdmin && (
          <Disclosure summary={t("sections.audit")} hint={t("sections.auditHint")}>
            <p className="text-sm text-muted-foreground">{t("audit.intro")}</p>
            <div>
              <Link
                href={`${workspaceHref(ws, "settings")}/audit`}
                className="text-sm font-medium text-brand underline"
              >
                {t("audit.open")}
              </Link>
            </div>
          </Disclosure>
        )}
        {isAdmin && (
          <Disclosure summary={t("sections.import")} hint={t("sections.importHint")}>
            <p className="text-sm text-muted-foreground">{t("importHint")}</p>
            <div>
              <Link
                href={`${workspaceHref(ws, "settings")}/import`}
                className="text-sm font-medium text-brand underline"
              >
                {t("importLink")}
              </Link>
            </div>
          </Disclosure>
        )}
        {isAdmin && (
          <Disclosure summary={t("sections.data")} hint={t("sections.dataHint")}>
            <WorkspaceData ws={ws} name={workspace.name} isOwner={workspace.role === "owner"} />
          </Disclosure>
        )}
      </section>
    </div>
  );
}
