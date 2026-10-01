/* "Who was told": every alert sent for an incident, per channel, with retries and errors. */
"use client";

import { useTranslations } from "next-intl";
import { CHANNEL_LABELS, type ChannelType } from "@app/shared";
import { CircleCheck, CircleDashed, CircleMinus, CircleX, type LucideIcon } from "lucide-react";
import { Loading } from "@/components/ui/skeleton";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useDeliveries, type DeliveryLogEntry } from "../api";

const STATUS: Record<DeliveryLogEntry["status"], { icon: LucideIcon; className: string }> = {
  sent: { icon: CircleCheck, className: "text-status-up" },
  failed: { icon: CircleX, className: "text-status-down" },
  skipped: { icon: CircleMinus, className: "text-muted-foreground" },
  pending: { icon: CircleDashed, className: "text-muted-foreground" },
  sending: { icon: CircleDashed, className: "text-muted-foreground" },
  retrying: { icon: CircleDashed, className: "text-status-degraded" },
};

export function DeliveryLog({
  ws,
  incidentId,
  live,
}: {
  ws: string;
  incidentId: string;
  live: boolean;
}) {
  const t = useTranslations("insights");
  const deliveries = useDeliveries(ws, incidentId, live);
  if (deliveries.isPending) return <Loading rows={2} />;
  if (deliveries.isError || deliveries.data.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("noDeliveries")}</p>;
  }
  return (
    <ul className="grid gap-2 text-sm">
      {deliveries.data.map((d) => {
        const { icon: Icon, className } = STATUS[d.status];
        return (
          <li key={d.id} className="flex gap-3 border-t pt-2 first:border-t-0 first:pt-0">
            <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", className)} />
            <div className="grid min-w-0 gap-0.5">
              <span>
                <span className="font-medium">
                  {d.channelName ?? t("deletedChannel")}
                  {d.channelType && (
                    <span className="font-normal text-muted-foreground">
                      {" "}
                      · {CHANNEL_LABELS[d.channelType as ChannelType] ?? d.channelType}
                    </span>
                  )}
                </span>
                {" — "}
                {t(`deliveryKind.${d.kind}`)}
              </span>
              <span className={cn("text-xs", className)}>
                {t(`deliveryStatus.${d.status}`)}
                {d.attempts > 1 && ` · ${t("attempts", { count: d.attempts })}`}
                {" · "}
                <time dateTime={d.sentAt ?? d.createdAt} className="text-muted-foreground">
                  {formatDateTime(d.sentAt ?? d.createdAt)}
                </time>
              </span>
              {d.error && (
                <span className="break-words text-xs text-muted-foreground">{d.error}</span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
