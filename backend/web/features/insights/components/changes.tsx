/* "What changed": address, certificate, settings and response-time changes, newest first. */
"use client";

import { useTranslations } from "next-intl";
import { Gauge, Network, Rocket, Settings2, ShieldCheck, type LucideIcon } from "lucide-react";
import { Loading } from "@/components/ui/skeleton";
import { formatDateTime } from "@/lib/format";
import { useChanges, type ChangeEvent } from "../api";

const ICONS: Record<ChangeEvent["kind"], LucideIcon> = {
  deploy: Rocket,
  address: Network,
  certificate: ShieldCheck,
  config: Settings2,
  latency: Gauge,
};

export function ChangeTimeline({
  ws,
  monitorId,
  before,
  empty,
}: {
  ws: string;
  monitorId: string;
  /* Look back from this moment (an incident's start); now when omitted. */
  before?: string;
  empty: string;
}) {
  const t = useTranslations("insights");
  const changes = useChanges(ws, monitorId, before);
  if (changes.isPending) return <Loading rows={2} />;
  if (changes.isError || changes.data.length === 0) {
    return <p className="text-sm text-muted-foreground">{empty}</p>;
  }
  return (
    <ol className="grid gap-3 text-sm">
      {changes.data.map((change) => {
        const Icon = ICONS[change.kind];
        return (
          <li key={`${change.kind}-${change.at}-${change.title}`} className="flex gap-3">
            <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="grid min-w-0 gap-0.5">
              <span className="font-medium">{change.title}</span>
              {change.detail && <span className="text-muted-foreground">{change.detail}</span>}
              <span className="text-xs text-muted-foreground">
                <time dateTime={change.at}>{formatDateTime(change.at)}</time>
                {change.regions.length > 0 &&
                  ` · ${t("inRegions", { regions: change.regions.join(", ") })}`}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
