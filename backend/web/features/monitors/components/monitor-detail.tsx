/*
 * Monitor detail: status, the likely cause while it fails, actions (Test now, pause, delete), 30-day
 * uptime and 90 day bars, the error budget and recent changes, the 24 h latency chart, SSL/domain
 * expiry when it applies, recent checks and incidents.
 */
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { explainFailure } from "@app/shared";
import { Pause, Pencil, Play, Trash2 } from "lucide-react";
import { StatusBadge } from "@/components/app/status-badge";
import { can, useWorkspace } from "@/components/app/workspace-context";
import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loading } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api";
import { formatDateTime, formatPercent } from "@/lib/format";
import { workspaceHref } from "@/lib/navigation";
import { IncidentList } from "@/features/incidents/components/incident-list";
import { MonitorBudgetCard } from "@/features/insights/components/budget";
import { ChangeTimeline } from "@/features/insights/components/changes";
import { ExplanationCard } from "@/features/insights/components/explanation";
import { TuningCard } from "@/features/insights/components/tuning";
import { monitorsApi, targetOf } from "../api";
import { monitorKeys, useMonitor, useMonitorStates, useReducedRegions } from "../hooks";
import { LatencyChart, UptimeBars } from "./charts";
import { TestNow } from "./test-now";

export function MonitorDetail({ monitorId }: { monitorId: string }) {
  const t = useTranslations("monitors");
  const tInsights = useTranslations("insights");
  const workspace = useWorkspace();
  const ws = workspace.id;
  const router = useRouter();
  const client = useQueryClient();
  const monitor = useMonitor(ws, monitorId);
  const states = useMonitorStates(ws);
  const reducedRegions = useReducedRegions(ws);
  const uptime = useQuery({
    queryKey: ["uptime", ws, monitorId],
    queryFn: () => monitorsApi.uptime(ws, monitorId),
  });
  const days = useQuery({
    queryKey: ["uptime-days", ws, monitorId],
    queryFn: async () => (await monitorsApi.uptimeDays(ws, monitorId)).data,
  });
  const latency = useQuery({
    queryKey: ["latency", ws, monitorId],
    queryFn: () => monitorsApi.latency(ws, monitorId),
    refetchInterval: 60_000,
  });
  const checks = useQuery({
    queryKey: ["checks", ws, monitorId],
    queryFn: async () => (await monitorsApi.checks(ws, monitorId)).data,
    refetchInterval: 10_000,
  });
  const type = monitor.data?.type;
  const hasExpiry =
    type === "ssl" ||
    type === "domain" ||
    (typeof monitor.data?.config.url === "string" &&
      monitor.data.config.url.startsWith("https://"));
  const expiry = useQuery({
    queryKey: ["expiry", ws, monitorId],
    queryFn: () => monitorsApi.expiry(ws, monitorId),
    enabled: hasExpiry,
  });

  if (monitor.isPending) return <Loading rows={4} className="max-w-5xl" />;
  if (monitor.isError) return <Alert tone="error">{errorMessage(monitor.error)}</Alert>;
  const data = monitor.data;
  const state = states.data?.get(data.id);
  const reduced = data.regions.filter((region) => reducedRegions.data?.includes(region));
  const status = data.paused ? "paused" : (state?.status ?? "pending");
  const canEdit = can(workspace.role, "monitor:write");
  /* While failing, explain the newest failed check the way alerts do. */
  const failing = status === "down" || status === "degraded" || status === "verifying";
  const lastFailure = failing ? (checks.data ?? []).find((c) => !c.ok) : undefined;
  const failingRegions = [
    ...new Set((checks.data ?? []).filter((c) => !c.ok).map((c) => c.region)),
  ];
  const explanation =
    lastFailure === undefined
      ? null
      : explainFailure({
          errorCode: lastFailure.errorCode,
          httpStatus: lastFailure.httpStatus,
          failingRegions,
          totalRegions: data.regions.length,
          target: targetOf(data),
        });

  async function setPaused(paused: boolean) {
    await monitorsApi.setPaused(ws, data.id, paused);
    await client.invalidateQueries({ queryKey: monitorKeys.one(ws, data.id) });
    await client.invalidateQueries({ queryKey: monitorKeys.all(ws) });
  }

  return (
    <div className="grid max-w-5xl gap-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="grid min-w-0 flex-1 gap-1">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{data.name}</h1>
          <p className="truncate text-sm text-muted-foreground">
            {t(`types.${data.type}`)} · {targetOf(data)}
          </p>
          {state?.reason && <p className="text-sm">{state.reason}</p>}
        </div>
        <StatusBadge status={status} />
      </div>

      {data.paused && <Alert tone="info">{t("pausedNotice")}</Alert>}
      {!data.paused && reduced.length > 0 && (
        <Alert tone={reduced.length === data.regions.length ? "error" : "info"}>
          {t(reduced.length === data.regions.length ? "notWatched" : "reducedConfirmation", {
            regions: reduced.join(", "),
          })}
        </Alert>
      )}
      {explanation && explanation.category !== "unknown" && (
        <ExplanationCard
          explanation={explanation}
          failingRegions={failingRegions}
          regionCount={data.regions.length}
        />
      )}

      {canEdit && (
        <div className="flex flex-wrap gap-2">
          {!data.paused && <TestNow ws={ws} monitorId={data.id} />}
          <div className="flex flex-wrap gap-2">
            {data.type !== "heartbeat" && (
              <Link
                href={workspaceHref(ws, `monitors/${data.id}/edit`)}
                className={buttonVariants({ variant: "outline" })}
              >
                <Pencil aria-hidden />
                {t("edit")}
              </Link>
            )}
            <Button variant="outline" onClick={() => setPaused(!data.paused)}>
              {data.paused ? <Play aria-hidden /> : <Pause aria-hidden />}
              {data.paused ? t("resume") : t("pause")}
            </Button>
            <Button
              variant="ghost"
              onClick={async () => {
                if (!window.confirm(t("confirmDelete"))) return;
                await monitorsApi.remove(ws, data.id);
                await client.invalidateQueries({ queryKey: monitorKeys.all(ws) });
                router.push(workspaceHref(ws, "monitors"));
              }}
            >
              <Trash2 aria-hidden />
              {t("delete")}
            </Button>
          </div>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>{t("uptime30")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold tabular-nums">
              {(checks.data ?? []).length === 0 ? "—" : formatPercent(uptime.data?.uptimePercent)}
            </p>
          </CardContent>
        </Card>
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>{t("uptimeBars")}</CardTitle>
          </CardHeader>
          <CardContent>{days.data && <UptimeBars days={days.data} />}</CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {data.type !== "heartbeat" && <MonitorBudgetCard ws={ws} monitorId={data.id} />}
        <Card>
          <CardHeader>
            <CardTitle>{tInsights("recentChanges")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ChangeTimeline ws={ws} monitorId={data.id} empty={tInsights("recentChangesEmpty")} />
          </CardContent>
        </Card>
      </div>

      {data.type !== "heartbeat" && <TuningCard ws={ws} monitorId={data.id} canEdit={canEdit} />}

      <Card>
        <CardHeader>
          <CardTitle>{t("latency")}</CardTitle>
        </CardHeader>
        <CardContent>
          <LatencyChart points={latency.data?.points ?? []} />
        </CardContent>
      </Card>

      {hasExpiry && expiry.data && (
        <Card>
          <CardHeader>
            <CardTitle>{t("expiry")}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {expiry.data.expiresAt && expiry.data.daysRemaining !== null ? (
              <p>
                {t("expiresIn", {
                  kind: expiry.data.kind === "ssl" ? t("certificate") : t("registration"),
                  days: expiry.data.daysRemaining,
                  date: formatDateTime(expiry.data.expiresAt),
                })}
              </p>
            ) : (
              <p>
                {t("expiryState", {
                  kind: expiry.data.kind === "ssl" ? t("certificate") : t("registration"),
                  status: expiry.data.message ?? expiry.data.status,
                })}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("recentChecks")}</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {checks.isSuccess && checks.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {data.paused ? t("noChecksPaused") : t("noChecksYet")}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    {t("checkedAt")}
                  </th>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    {t("region")}
                  </th>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    {t("result")}
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    {t("latencyMs")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {(checks.data ?? []).map((check) => (
                  <tr key={check.id} className="border-t">
                    <td className="py-1 pr-3">{formatDateTime(check.checkedAt)}</td>
                    <td className="py-1 pr-3">{check.region}</td>
                    <td className="py-1 pr-3">
                      {check.ok ? t("testOk") : `${t("testFailed")} (${check.errorCode ?? "?"})`}
                    </td>
                    <td className="py-1 tabular-nums">{Math.round(check.latencyMs)} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <section className="grid gap-2" aria-labelledby="monitor-incidents">
        <h2 id="monitor-incidents" className="text-base font-semibold">
          {t("incidents")}
        </h2>
        <IncidentList ws={ws} monitorId={data.id} />
      </section>
    </div>
  );
}
