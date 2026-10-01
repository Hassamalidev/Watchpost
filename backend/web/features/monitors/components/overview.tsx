/* Overview: health tiles, open incidents, the status wall and error budgets (PRODUCT.md §14). */
"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import { can, useWorkspace } from "@/components/app/workspace-context";
import { Alert } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Loading } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api";
import { workspaceHref } from "@/lib/navigation";
import { IncidentList } from "@/features/incidents/components/incident-list";
import { BudgetList } from "@/features/insights/components/budget";
import { HealthSummary } from "@/features/insights/components/summary";
import { NoisyMonitors } from "@/features/insights/components/tuning";
import { useMonitor } from "../hooks";
import { MonitorForm } from "./monitor-form";
import { MonitorList } from "./monitor-list";

export function OverviewView() {
  const t = useTranslations("overview");
  const tInsights = useTranslations("insights");
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
      <HealthSummary ws={ws} />
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
      <NoisyMonitors ws={ws} />
      <section className="grid gap-2" aria-labelledby="error-budgets">
        <h2 id="error-budgets" className="text-base font-semibold">
          {tInsights("budgetsTitle")}
        </h2>
        <BudgetList ws={ws} />
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

export function EditMonitorView({ monitorId }: { monitorId: string }) {
  const t = useTranslations("monitors");
  const workspace = useWorkspace();
  const monitor = useMonitor(workspace.id, monitorId);
  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{t("editTitle")}</h1>
      {monitor.isPending ? (
        <Loading rows={4} className="max-w-xl" />
      ) : monitor.isError ? (
        <Alert tone="error">{errorMessage(monitor.error)}</Alert>
      ) : (
        <MonitorForm ws={workspace.id} monitor={monitor.data} />
      )}
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
