/*
 * Overview health tiles: what's up right now, how trustworthy the alerts were, how fast the team
 * responds, and whether any error budget is in trouble.
 */
"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Activity, Gauge, ShieldCheck, Timer, type LucideIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useMonitorStates, useMonitors } from "@/features/monitors/hooks";
import { useBudgets, useSummary } from "../api";

function Tile({
  icon: Icon,
  label,
  value,
  note,
  pending,
}: {
  icon: LucideIcon;
  label: string;
  value: React.ReactNode;
  note: React.ReactNode;
  pending: boolean;
}) {
  return (
    <div className="grid content-start gap-1 rounded-lg border bg-card p-4">
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Icon aria-hidden className="size-4 shrink-0" />
        {label}
      </p>
      {pending ? (
        <>
          <Skeleton className="my-1 h-7 w-20" />
          <Skeleton className="h-3 w-32" />
        </>
      ) : (
        <>
          <p className="text-2xl font-semibold tabular-nums">{value}</p>
          <p className="text-xs text-muted-foreground">{note}</p>
        </>
      )}
    </div>
  );
}

const minutes = (value: number | null) =>
  value === null ? "—" : value < 60 ? `${Math.round(value)}m` : `${(value / 60).toFixed(1)}h`;

export function HealthSummary({ ws }: { ws: string }) {
  const t = useTranslations("insights");
  const monitors = useMonitors(ws);
  const states = useMonitorStates(ws);
  const summary = useSummary(ws);
  const budgets = useBudgets(ws);

  const list = monitors.data ?? [];
  const active = list.filter((m) => !m.paused);
  const statusOf = (id: string) => states.data?.get(id)?.status ?? "pending";
  const up = active.filter((m) => statusOf(m.id) === "up").length;
  const down = active.filter((m) => ["down", "degraded"].includes(statusOf(m.id))).length;
  const waiting = active.filter((m) => ["pending", "verifying"].includes(statusOf(m.id))).length;
  const atRisk = (budgets.data ?? []).filter((b) => b.status !== "healthy").length;
  const s = summary.data;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Tile
        icon={Activity}
        label={t("tileMonitors")}
        pending={monitors.isPending || states.isPending}
        value={list.length === 0 ? "—" : `${up}/${active.length}`}
        note={
          down > 0
            ? t("tileMonitorsDown", { count: down })
            : list.length === 0
              ? t("tileMonitorsNone")
              : waiting > 0
                ? t("tileMonitorsWaiting", { count: waiting })
                : t("tileMonitorsUp")
        }
      />
      <Tile
        icon={ShieldCheck}
        label={t("tileAccuracy")}
        pending={summary.isPending}
        value={s?.accuracyPercent === null || s === undefined ? "—" : `${s.accuracyPercent}%`}
        note={
          s === undefined || s.incidents === 0
            ? t("tileAccuracyNone")
            : t("tileAccuracyNote", { incidents: s.incidents, falseAlarms: s.falseAlarms })
        }
      />
      <Tile
        icon={Timer}
        label={t("tileResponse")}
        pending={summary.isPending}
        value={s ? `${minutes(s.mttaMinutes)} / ${minutes(s.mttrMinutes)}` : "—"}
        note={t("tileResponseNote")}
      />
      <Tile
        icon={Gauge}
        label={t("tileBudgets")}
        pending={budgets.isPending}
        value={(budgets.data ?? []).length === 0 ? "—" : atRisk === 0 ? t("tileBudgetsOk") : atRisk}
        note={
          (budgets.data ?? []).length === 0
            ? t("tileBudgetsNone")
            : atRisk === 0
              ? t("tileBudgetsOkNote")
              : t("tileBudgetsRisk", { count: atRisk })
        }
      />
    </div>
  );
}
