/*
 * On an incident: where its escalation stands (which step, when the next one is due, or why it
 * stopped) and "Escalate now" for whoever is responding. Renders nothing without an escalation.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { IncidentEscalationView } from "@app/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, errorMessage, wsPath } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

export function IncidentEscalation({
  ws,
  incidentId,
  live,
  canRespond,
}: {
  ws: string;
  incidentId: string;
  /* Refresh while the incident is open. */
  live: boolean;
  canRespond: boolean;
}) {
  const t = useTranslations("oncall.incident");
  const client = useQueryClient();
  const key = ["incident-escalation", ws, incidentId] as const;
  const escalation = useQuery({
    queryKey: key,
    queryFn: async () =>
      (
        await api<{ data: IncidentEscalationView | null }>(
          wsPath(ws, `/incidents/${incidentId}/escalation`),
        )
      ).data,
    refetchInterval: live ? 15_000 : false,
  });
  const now = useMutation({
    mutationFn: () =>
      api<{ data: IncidentEscalationView }>(wsPath(ws, `/incidents/${incidentId}/escalate`), {
        method: "POST",
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: key });
      await client.invalidateQueries({ queryKey: ["incident", ws] });
    },
  });
  const data = escalation.data;
  if (data === undefined || data === null) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 text-sm">
        <p>
          {t("progress", { name: data.policyName, run: data.stepsRun, total: data.totalSteps })}
        </p>
        <p className="text-muted-foreground">
          {data.finished !== null
            ? t(`finished.${data.finished}`)
            : data.nextStepAt === null
              ? ""
              : t("nextAt", { time: formatDateTime(data.nextStepAt) })}
        </p>
        {now.isError && <Alert tone="error">{errorMessage(now.error)}</Alert>}
        {canRespond && data.finished === null && (
          <div>
            <Button
              type="button"
              variant="outline"
              disabled={now.isPending}
              onClick={() => now.mutate()}
            >
              {t("escalateNow")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
