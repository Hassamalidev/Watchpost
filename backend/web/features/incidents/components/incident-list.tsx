/* Incidents with status, severity, start and duration; the filter lives in the URL (`?status=`). */
"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { CircleAlert, CircleCheck, CircleDot } from "lucide-react";
import { EmptyState } from "@/components/ui/alert";
import { Loading } from "@/components/ui/skeleton";
import { formatDuration, relativeTime } from "@/lib/format";
import { workspaceHref } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { useIncidents, type IncidentStatus } from "../api";

const STATUS_ICON: Record<IncidentStatus, { icon: typeof CircleAlert; tone: string }> = {
  triggered: { icon: CircleAlert, tone: "text-status-down" },
  acknowledged: { icon: CircleDot, tone: "text-status-degraded" },
  snoozed: { icon: CircleDot, tone: "text-status-paused" },
  resolved: { icon: CircleCheck, tone: "text-status-up" },
};

export function IncidentStatusLabel({ status }: { status: IncidentStatus }) {
  const t = useTranslations("incidents");
  const { icon: Icon, tone } = STATUS_ICON[status];
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium", tone)}>
      <Icon aria-hidden className="size-3.5" />
      {t(`statuses.${status}`)}
    </span>
  );
}

export function IncidentList({
  ws,
  status,
  monitorId,
  severity,
  emptyTitle,
}: {
  ws: string;
  status?: string;
  monitorId?: string;
  severity?: string;
  emptyTitle?: string;
}) {
  const t = useTranslations("incidents");
  const incidents = useIncidents(ws, {
    ...(status ? { status } : {}),
    ...(monitorId ? { monitorId } : {}),
    ...(severity ? { severity } : {}),
  });
  if (incidents.isPending) return <Loading rows={2} />;
  const list = incidents.data ?? [];
  if (list.length === 0) return <EmptyState title={emptyTitle ?? t("empty")} />;
  return (
    <ul className="divide-y rounded-lg border">
      {list.map((incident) => (
        <li key={incident.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
          <IncidentStatusLabel status={incident.status} />
          <Link
            href={workspaceHref(ws, `incidents/${incident.number}`)}
            className="min-w-0 flex-1 truncate font-medium hover:underline"
          >
            #{incident.number} {incident.title}
          </Link>
          <span className="text-xs text-muted-foreground">
            {relativeTime(incident.startedAt)} · {formatDuration(incident.durationSeconds)}
          </span>
        </li>
      ))}
    </ul>
  );
}
