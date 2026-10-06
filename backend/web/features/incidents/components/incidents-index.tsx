/*
 * Incidents page: open, resolved or all, narrowed by severity and monitor. Every filter lives in the
 * URL, so a filtered view can be bookmarked or shared.
 */
"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { SEVERITIES } from "@app/shared";
import { useWorkspace } from "@/components/app/workspace-context";
import { Select } from "@/components/ui/input";
import { workspaceHref } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { useMonitors } from "@/features/monitors/hooks";
import { IncidentList } from "./incident-list";

const FILTERS = ["open", "resolved", "all"] as const;

export function IncidentsIndex({
  status,
  severity,
  monitorId,
}: {
  status: (typeof FILTERS)[number];
  severity: string;
  monitorId: string;
}) {
  const t = useTranslations("incidents");
  const tMonitors = useTranslations("monitors");
  const workspace = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const monitors = useMonitors(workspace.id);

  const hrefWith = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === "") next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    return query === "" ? pathname : `${pathname}?${query}`;
  };

  return (
    <div className="grid max-w-4xl gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <div className="flex flex-wrap items-center gap-3">
        <nav aria-label={t("title")} className="flex gap-1">
          {FILTERS.map((filter) => (
            <Link
              key={filter}
              href={`${workspaceHref(workspace.id, "incidents")}?${new URLSearchParams({
                ...Object.fromEntries(params.entries()),
                status: filter,
              }).toString()}`}
              aria-current={filter === status ? "page" : undefined}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm hover:bg-accent",
                filter === status && "bg-accent font-medium",
              )}
            >
              {t(filter)}
            </Link>
          ))}
        </nav>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <Select
            aria-label={t("filterSeverity")}
            className="h-9 w-auto"
            value={severity}
            onChange={(e) => router.replace(hrefWith({ severity: e.target.value }))}
          >
            <option value="">{t("allSeverities")}</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {tMonitors(`severities.${s}`)}
              </option>
            ))}
          </Select>
          <Select
            aria-label={t("filterMonitor")}
            className="h-9 w-auto max-w-56"
            value={monitorId}
            onChange={(e) => router.replace(hrefWith({ monitor: e.target.value }))}
          >
            <option value="">{t("allMonitors")}</option>
            {(monitors.data ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <IncidentList
        ws={workspace.id}
        {...(status === "all" ? {} : { status })}
        {...(severity ? { severity } : {})}
        {...(monitorId ? { monitorId } : {})}
        {...(severity || monitorId ? { emptyTitle: t("emptyFiltered") } : {})}
      />
    </div>
  );
}
