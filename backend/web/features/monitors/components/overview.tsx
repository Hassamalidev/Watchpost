/* Overview: the status wall and open incidents (PRODUCT.md §14). */
"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import { can, useWorkspace } from "@/components/app/workspace-context";
import { buttonVariants } from "@/components/ui/button";
import { workspaceHref } from "@/lib/navigation";
import { IncidentList } from "@/features/incidents/components/incident-list";
import { MonitorForm } from "./monitor-form";
import { MonitorList } from "./monitor-list";

export function OverviewView() {
  const t = useTranslations("overview");
  const workspace = useWorkspace();
  const ws = workspace.id;
  const addFirst = can(workspace.role, "member") ? (
    <Link href={workspaceHref(ws, "monitors/new")} className={buttonVariants({ size: "sm" })}>
      <Plus aria-hidden />
      {t("addFirst")}
    </Link>
  ) : undefined;
  return (
    <div className="grid max-w-5xl gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-1 text-muted-foreground">{t("intro")}</p>
      </div>
      <section className="grid gap-2" aria-labelledby="open-incidents">
        <h2 id="open-incidents" className="text-base font-semibold">
          {t("openIncidents")}
        </h2>
        <IncidentList ws={ws} status="open" emptyTitle={t("noIncidents")} />
      </section>
      <section className="grid gap-2" aria-labelledby="status-wall">
        <h2 id="status-wall" className="text-base font-semibold">
          {t("statusWall")}
        </h2>
        <MonitorList ws={ws} emptyAction={addFirst} />
      </section>
    </div>
  );
}

export function MonitorsIndex() {
  const t = useTranslations("monitors");
  const workspace = useWorkspace();
  return (
    <div className="grid max-w-5xl gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex-1 text-2xl font-semibold tracking-tight">{t("title")}</h1>
        {can(workspace.role, "member") && (
          <Link
            href={workspaceHref(workspace.id, "monitors/new")}
            className={buttonVariants({ size: "sm" })}
          >
            <Plus aria-hidden />
            {t("new")}
          </Link>
        )}
      </div>
      <MonitorList ws={workspace.id} />
    </div>
  );
}

export function NewMonitorView() {
  const t = useTranslations("monitors");
  const workspace = useWorkspace();
  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{t("createTitle")}</h1>
      <MonitorForm ws={workspace.id} />
    </div>
  );
}
