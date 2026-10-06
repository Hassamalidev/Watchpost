/*
 * Incident detail: state and large action buttons, the likely cause and first checks, facts, what
 * changed before it started, who was notified, timeline and comments. Built for a phone at 3 a.m.
 * (PRODUCT.md §14): one column, big targets, polling while open.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Siren } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import { can, useWorkspace } from "@/components/app/workspace-context";
import { Loading } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api";
import { formatDateTime, formatDuration } from "@/lib/format";
import { workspaceHref } from "@/lib/navigation";
import { ChangeTimeline } from "@/features/insights/components/changes";
import { DeliveryLog } from "@/features/insights/components/deliveries";
import { ExplanationCard } from "@/features/insights/components/explanation";
import { incidentsApi, useIncident, useIncidentAction } from "../api";
import { EvidencePanel } from "./evidence-panel";
import { IncidentStatusLabel } from "./incident-list";

export function IncidentDetailView({ incidentRef }: { incidentRef: string }) {
  const t = useTranslations("incidents");
  const tInsights = useTranslations("insights");
  const tMonitors = useTranslations("monitors");
  const workspace = useWorkspace();
  const ws = workspace.id;
  const incident = useIncident(ws, incidentRef);
  const action = useIncidentAction(ws, incidentRef);
  const [comment, setComment] = React.useState("");
  const canRespondNow = can(workspace.role, "responder");

  /* A acknowledges and R resolves, unless the user is typing (PRODUCT.md §14 keyboard-first). */
  React.useEffect(() => {
    const current = incident.data;
    if (!current || !canRespondNow) return;
    function onKey(event: KeyboardEvent) {
      if (!current || event.metaKey || event.ctrlKey || event.altKey || action.isPending) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      const key = event.key.toLowerCase();
      if (key === "a" && current.status === "triggered") {
        event.preventDefault();
        action.mutate(() => incidentsApi.act(ws, current.id, "acknowledge"));
      } else if (key === "r" && current.status !== "resolved") {
        event.preventDefault();
        action.mutate(() => incidentsApi.act(ws, current.id, "resolve"));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [incident.data, canRespondNow, action, ws]);

  if (incident.isPending) return <Loading rows={4} className="max-w-3xl" />;
  if (incident.isError) return <Alert tone="error">{errorMessage(incident.error)}</Alert>;
  const data = incident.data;
  /* Responders act on incidents; flagging false alarms is for members (PRODUCT.md §6.11). */
  const canRespond = can(workspace.role, "responder");
  const canFlag = can(workspace.role, "member");
  const open = data.status !== "resolved";

  return (
    <div className="grid max-w-3xl gap-6">
      {data.source === "drill" && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-status-maintenance/40 bg-status-maintenance/10 px-3 py-2 text-sm text-status-maintenance"
        >
          <Siren aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p>{tInsights("drillBanner")}</p>
        </div>
      )}
      <div className="grid gap-2">
        <IncidentStatusLabel status={data.status} />
        <h1 className="text-2xl font-semibold tracking-tight">
          #{data.number} {data.title}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("severityLabel", { severity: tMonitors(`severities.${data.severity}`) })} ·{" "}
          {formatDateTime(data.startedAt)} · {formatDuration(data.durationSeconds)}
          {data.monitor && (
            <>
              {" · "}
              <Link
                href={workspaceHref(ws, `monitors/${data.monitor.id}`)}
                className="text-foreground underline"
              >
                {tInsights("monitorLink", { name: data.monitor.name })}
              </Link>
            </>
          )}
        </p>
      </div>

      {canRespond && (
        <div className="flex flex-wrap gap-2">
          {data.status === "triggered" && (
            <Button
              className="h-11 px-6"
              aria-keyshortcuts="A"
              disabled={action.isPending}
              onClick={() => action.mutate(() => incidentsApi.act(ws, data.id, "acknowledge"))}
            >
              {t("acknowledge")}
              <kbd
                aria-hidden
                className="ml-1 hidden rounded border border-current/30 px-1 text-xs font-normal opacity-80 sm:inline"
              >
                A
              </kbd>
            </Button>
          )}
          {open && (
            <Button
              variant="outline"
              className="h-11 px-6"
              aria-keyshortcuts="R"
              disabled={action.isPending}
              onClick={() => action.mutate(() => incidentsApi.act(ws, data.id, "resolve"))}
            >
              {t("resolve")}
              <kbd
                aria-hidden
                className="ml-1 hidden rounded border border-current/30 px-1 text-xs font-normal opacity-80 sm:inline"
              >
                R
              </kbd>
            </Button>
          )}
          {canFlag && (
            <Button
              variant="ghost"
              className="h-11"
              disabled={action.isPending}
              onClick={() =>
                action.mutate(() => incidentsApi.falseAlarm(ws, data.id, !data.falseAlarm))
              }
            >
              {data.falseAlarm ? t("notFalseAlarm") : t("falseAlarm")}
            </Button>
          )}
        </div>
      )}
      {action.isError && <Alert tone="error">{errorMessage(action.error)}</Alert>}

      {data.recentDeploy && !data.explanation && (
        <Alert tone="info">
          {tInsights("deploySuspect", {
            version: data.recentDeploy.service
              ? `${data.recentDeploy.service} ${data.recentDeploy.version}`
              : data.recentDeploy.version,
            minutes: data.recentDeploy.minutesBefore,
          })}
        </Alert>
      )}
      {data.explanation && open && (
        <ExplanationCard
          explanation={data.explanation}
          failingRegions={data.failingRegions}
          regionCount={data.monitor?.regionCount ?? null}
        />
      )}

      {(data.causeCode !== null || data.failingRegions.length > 0) && (
        <Card>
          <CardContent className="grid gap-3 pt-5 text-sm sm:grid-cols-2">
            <div>
              <p className="text-muted-foreground">{t("cause")}</p>
              <p className="font-mono text-xs font-medium">{data.causeCode ?? "—"}</p>
            </div>
            <div>
              <p className="text-muted-foreground">{t("regions")}</p>
              <p className="font-medium">
                {data.failingRegions.join(", ") || "—"}
                {data.monitor && data.failingRegions.length > 0 && (
                  <span className="font-normal text-muted-foreground">
                    {" "}
                    (
                    {t("regionsOf", {
                      count: data.failingRegions.length,
                      total: data.monitor.regionCount,
                    })}
                    )
                  </span>
                )}
              </p>
            </div>
            {data.timing && (
              <div className="sm:col-span-2">
                <p className="text-muted-foreground">{t("timing")}</p>
                <p className="font-medium">{data.timing}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <EvidencePanel ws={ws} incidentRef={incidentRef} />

      <div className="grid gap-4 md:grid-cols-2">
        {data.monitor && (
          <Card>
            <CardHeader>
              <CardTitle>{tInsights("whatChanged")}</CardTitle>
            </CardHeader>
            <CardContent>
              <ChangeTimeline
                ws={ws}
                monitorId={data.monitor.id}
                before={data.startedAt}
                empty={tInsights("whatChangedEmpty")}
              />
            </CardContent>
          </Card>
        )}
        <Card className={data.monitor ? undefined : "md:col-span-2"}>
          <CardHeader>
            <CardTitle>{tInsights("whoWasTold")}</CardTitle>
          </CardHeader>
          <CardContent>
            <DeliveryLog ws={ws} incidentId={data.id} live={open} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("timeline")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="grid gap-3 text-sm">
            {data.timeline.map((event) => {
              const commentBody =
                event.type === "comment"
                  ? data.comments.find((c) => c.id === event.data.commentId)?.body
                  : undefined;
              const known = [
                "triggered",
                "acknowledged",
                "resolved",
                "comment",
                "updated",
                "delivery_failed",
                "false_alarm_marked",
                "false_alarm_cleared",
                "flapping_started",
                "flapping_stopped",
              ] as const;
              const type = known.find((k) => k === event.type);
              return (
                <li key={event.id} className="grid gap-0.5 border-l-2 pl-3">
                  <span className="font-medium">{type ? t(`events.${type}`) : event.type}</span>
                  <time className="text-xs text-muted-foreground" dateTime={event.at}>
                    {formatDateTime(event.at)}
                  </time>
                  {commentBody && <p className="whitespace-pre-wrap">{commentBody}</p>}
                </li>
              );
            })}
          </ol>
          {canRespond && (
            <form
              className="mt-4 grid gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (comment.trim() === "") return;
                action.mutate(() => incidentsApi.comment(ws, data.id, comment.trim()), {
                  onSuccess: () => setComment(""),
                });
              }}
            >
              <Field label={t("comment")} htmlFor="incident-comment">
                <Textarea
                  id="incident-comment"
                  value={comment}
                  placeholder={t("commentPlaceholder")}
                  onChange={(e) => setComment(e.target.value)}
                />
              </Field>
              <div>
                <Button type="submit" size="sm" disabled={action.isPending}>
                  {t("post")}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
