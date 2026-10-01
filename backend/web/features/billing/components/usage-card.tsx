/* Usage against the plan: monitors, heartbeat monitors and team members. Text carries every number. */
"use client";

import { useTranslations } from "next-intl";
import type { UsageMeter } from "@app/shared";
import { Alert } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loading } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useMonitorUsage, type BillingState } from "../api";

export function Meter({ label, meter }: { label: string; meter: UsageMeter }) {
  const t = useTranslations("billing");
  const unlimited = meter.limit === "unlimited";
  const limit = unlimited ? 0 : (meter.limit as number);
  const percent = unlimited || limit === 0 ? 0 : Math.min(100, (meter.used / limit) * 100);
  const full = !unlimited && meter.used >= limit;
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className={cn("text-muted-foreground", full && "font-medium text-status-degraded")}>
          {unlimited
            ? t("usageUnlimited", { used: meter.used })
            : t("usageOf", { used: meter.used, limit })}
        </span>
      </div>
      {!unlimited && (
        <div
          role="meter"
          aria-label={t("usageMeter", { label, used: meter.used, limit })}
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={Math.min(meter.used, limit)}
          className="h-2 overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn("h-full rounded-full", full ? "bg-status-degraded" : "bg-brand")}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
    </div>
  );
}

export function UsageCard({ ws, state }: { ws: string; state: BillingState }) {
  const t = useTranslations("billing");
  const usage = useMonitorUsage(ws);
  return (
    <Card aria-labelledby="billing-usage-heading">
      <CardHeader>
        <CardTitle id="billing-usage-heading">{t("usageTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {usage.data ? (
          <>
            <Meter label={t("usageMonitors")} meter={usage.data.monitors} />
            <Meter label={t("usageHeartbeats")} meter={usage.data.heartbeats} />
          </>
        ) : (
          <Loading rows={2} />
        )}
        <Meter label={t("usageMembers")} meter={state.usage.members} />
        {usage.data !== undefined && usage.data.pausedByPlan > 0 && (
          <Alert tone="info">{t("pausedByPlan", { count: usage.data.pausedByPlan })}</Alert>
        )}
      </CardContent>
    </Card>
  );
}
