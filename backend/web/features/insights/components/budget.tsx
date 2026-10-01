/*
 * Error budgets: how much downtime the monthly target still allows, and whether the current pace
 * would use it up before the month ends. Status is always spelled out, never shown by color alone.
 */
"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { CircleCheck, CircleX, TriangleAlert, type LucideIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/alert";
import { Loading } from "@/components/ui/skeleton";
import { formatDuration } from "@/lib/format";
import { workspaceHref } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { useBudget, useBudgets, type BudgetStatus, type ErrorBudget } from "../api";

const STATUS: Record<BudgetStatus, { icon: LucideIcon; text: string; bar: string }> = {
  healthy: { icon: CircleCheck, text: "text-status-up", bar: "bg-status-up" },
  at_risk: { icon: TriangleAlert, text: "text-status-degraded", bar: "bg-status-degraded" },
  exhausted: { icon: CircleX, text: "text-status-down", bar: "bg-status-down" },
};

export function BudgetStatusLabel({ status }: { status: BudgetStatus }) {
  const t = useTranslations("insights");
  const { icon: Icon, text } = STATUS[status];
  return (
    <span className={cn("inline-flex items-center gap-1 text-sm font-medium", text)}>
      <Icon aria-hidden className="size-4" />
      {t(`budgetStatus.${status}`)}
    </span>
  );
}

export function BudgetMeter({ budget, label }: { budget: ErrorBudget; label: string }) {
  const t = useTranslations("insights");
  const used = budget.budgetSeconds === 0 ? 100 : (budget.usedSeconds / budget.budgetSeconds) * 100;
  const shown = Math.min(100, Math.max(0, used));
  return (
    <div className="grid gap-1.5">
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(shown)}
        aria-valuetext={t("budgetUsedPercent", { percent: Math.round(used) })}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn("h-full rounded-full", STATUS[budget.status].bar)}
          style={{ width: `${shown}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {budget.remainingSeconds > 0
          ? t("budgetLeft", {
              left: formatDuration(budget.remainingSeconds),
              total: formatDuration(budget.budgetSeconds),
            })
          : t("budgetOver", { over: formatDuration(-budget.remainingSeconds) })}
      </p>
    </div>
  );
}

/* The monitor page card: target, meter, pace. */
export function MonitorBudgetCard({ ws, monitorId }: { ws: string; monitorId: string }) {
  const t = useTranslations("insights");
  const budget = useBudget(ws, monitorId);
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>{t("budgetTitle")}</CardTitle>
        {budget.data && <BudgetStatusLabel status={budget.data.status} />}
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {budget.data ? (
          <>
            <p className="text-muted-foreground">
              {t("budgetTarget", { target: budget.data.target })}
            </p>
            <BudgetMeter budget={budget.data} label={t("budgetTitle")} />
            <p>
              {budget.data.status === "healthy"
                ? t("budgetPaceOk")
                : budget.data.status === "at_risk"
                  ? t("budgetPaceRisk", { rate: budget.data.burnRate })
                  : t("budgetPaceGone")}
            </p>
          </>
        ) : (
          <Loading rows={2} />
        )}
      </CardContent>
    </Card>
  );
}

/* Overview: the monitors using their budget fastest. */
export function BudgetList({ ws, limit = 5 }: { ws: string; limit?: number }) {
  const t = useTranslations("insights");
  const budgets = useBudgets(ws);
  if (budgets.isPending) return <Loading rows={2} />;
  const rows = (budgets.data ?? []).slice(0, limit);
  if (rows.length === 0) return <EmptyState title={t("budgetsEmpty")} />;
  return (
    <ul className="grid gap-3">
      {rows.map((b) => (
        <li key={b.monitorId} className="grid gap-1.5 rounded-lg border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Link
              href={workspaceHref(ws, `monitors/${b.monitorId}`)}
              className="min-w-0 truncate font-medium hover:underline"
            >
              {b.name}
            </Link>
            <BudgetStatusLabel status={b.status} />
          </div>
          <BudgetMeter budget={b} label={t("budgetOf", { name: b.name })} />
        </li>
      ))}
    </ul>
  );
}
