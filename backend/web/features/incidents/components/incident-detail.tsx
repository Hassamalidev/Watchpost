/*
 * Incident detail: state and large action buttons, facts, timeline and comments. Built for a phone
 * at 3 a.m. (PRODUCT.md §14): one column, big targets, polling while open.
 */
"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import { can, useWorkspace } from "@/components/app/workspace-context";
import { errorMessage } from "@/lib/api";
import { formatDateTime, formatDuration } from "@/lib/format";
import { incidentsApi, useIncident, useIncidentAction } from "../api";
import { IncidentStatusLabel } from "./incident-list";

export function IncidentDetailView({ incidentRef }: { incidentRef: string }) {
  const t = useTranslations("incidents");
  const tApp = useTranslations("app");
  const workspace = useWorkspace();
  const ws = workspace.id;
  const incident = useIncident(ws, incidentRef);
  const action = useIncidentAction(ws, incidentRef);
  const [comment, setComment] = React.useState("");

  if (incident.isPending) return <p className="text-muted-foreground">{tApp("loading")}</p>;
  if (incident.isError) return <Alert tone="error">{errorMessage(incident.error)}</Alert>;
  const data = incident.data;
  /* Responders act on incidents; flagging false alarms is for members (PRODUCT.md §6.11). */
  const canRespond = can(workspace.role, "responder");
  const canFlag = can(workspace.role, "member");
  const open = data.status !== "resolved";

  return (
    <div className="grid max-w-3xl gap-6">
      <div className="grid gap-2">
        <IncidentStatusLabel status={data.status} />
        <h1 className="text-2xl font-semibold tracking-tight">
          #{data.number} {data.title}
        </h1>
        <p className="text-sm text-muted-foreground">
          {formatDateTime(data.startedAt)} · {formatDuration(data.durationSeconds)}
        </p>
      </div>

      {canRespond && (
        <div className="flex flex-wrap gap-2">
          {data.status === "triggered" && (
            <Button
              className="h-11 px-6"
              disabled={action.isPending}
              onClick={() => action.mutate(() => incidentsApi.act(ws, data.id, "acknowledge"))}
            >
              {t("acknowledge")}
            </Button>
          )}
          {open && (
            <Button
              variant="outline"
              className="h-11 px-6"
              disabled={action.isPending}
              onClick={() => action.mutate(() => incidentsApi.act(ws, data.id, "resolve"))}
            >
              {t("resolve")}
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

      <Card>
        <CardContent className="grid gap-2 pt-5 text-sm sm:grid-cols-3">
          <div>
            <p className="text-muted-foreground">{t("severity")}</p>
            <p className="font-medium">{data.severity}</p>
          </div>
          <div>
            <p className="text-muted-foreground">{t("cause")}</p>
            <p className="font-medium">{data.causeCode ?? "—"}</p>
          </div>
          <div>
            <p className="text-muted-foreground">{t("regions")}</p>
            <p className="font-medium">{data.failingRegions.join(", ") || "—"}</p>
          </div>
        </CardContent>
      </Card>

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
