/* Monitors with their live status; the status wall on Overview uses the same list. */
"use client";

import type * as React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { StatusBadge } from "@/components/app/status-badge";
import { EmptyState } from "@/components/ui/alert";
import { relativeTime } from "@/lib/format";
import { workspaceHref } from "@/lib/navigation";
import { targetOf } from "../api";
import { useMonitorStates, useMonitors } from "../hooks";

export function MonitorList({ ws, emptyAction }: { ws: string; emptyAction?: React.ReactNode }) {
  const t = useTranslations("monitors");
  const tApp = useTranslations("app");
  const monitors = useMonitors(ws);
  const states = useMonitorStates(ws);
  if (monitors.isPending) return <p className="text-muted-foreground">{tApp("loading")}</p>;
  const list = (monitors.data ?? []).filter((m) => m.type !== "heartbeat");
  if (list.length === 0) return <EmptyState title={t("empty")}>{emptyAction}</EmptyState>;

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              {t("status")}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {t("name")}
            </th>
            <th scope="col" className="hidden px-3 py-2 font-medium sm:table-cell">
              {t("type")}
            </th>
            <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">
              {t("target")}
            </th>
          </tr>
        </thead>
        <tbody>
          {list.map((monitor) => {
            const state = states.data?.get(monitor.id);
            const status = monitor.paused ? "paused" : (state?.status ?? "pending");
            return (
              <tr key={monitor.id} className="border-t">
                <td className="px-3 py-2">
                  <StatusBadge status={status} />
                </td>
                <td className="px-3 py-2">
                  <Link
                    href={workspaceHref(ws, `monitors/${monitor.id}`)}
                    className="font-medium hover:underline"
                  >
                    {monitor.name}
                  </Link>
                  {state?.since && (
                    <span className="block text-xs text-muted-foreground">
                      {relativeTime(state.since)}
                    </span>
                  )}
                </td>
                <td className="hidden px-3 py-2 sm:table-cell">{t(`types.${monitor.type}`)}</td>
                <td className="hidden max-w-xs truncate px-3 py-2 text-muted-foreground md:table-cell">
                  {targetOf(monitor)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
