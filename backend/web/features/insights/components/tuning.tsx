/*
 * Alert tuning advisor (P1-T28): concrete setting changes that cut noise, from the monitor's last 30
 * days of incidents. Each suggestion applies with one click and changes only the settings it names.
 */
"use client";

import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { SlidersHorizontal } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loading } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api";
import { workspaceHref } from "@/lib/navigation";
import { monitorsApi } from "@/features/monitors/api";
import { monitorKeys } from "@/features/monitors/hooks";
import { useNoisiest, useTuning, type TuningSuggestion } from "../api";

export function TuningCard({
  ws,
  monitorId,
  canEdit,
}: {
  ws: string;
  monitorId: string;
  canEdit: boolean;
}) {
  const t = useTranslations("insights");
  const client = useQueryClient();
  const tuning = useTuning(ws, monitorId);
  const apply = useMutation({
    mutationFn: (s: TuningSuggestion) => monitorsApi.update(ws, monitorId, { settings: s.patch }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: monitorKeys.one(ws, monitorId) });
      await client.invalidateQueries({ queryKey: ["alert-tuning", ws] });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SlidersHorizontal aria-hidden className="size-4" />
          {t("tuningTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {tuning.isPending ? (
          <Loading rows={2} />
        ) : tuning.isError ? (
          <Alert tone="error">{errorMessage(tuning.error)}</Alert>
        ) : (
          <>
            <p className="text-muted-foreground">
              {t("tuningStats", {
                incidents: tuning.data.stats.incidents,
                falseAlarms: tuning.data.stats.falseAlarms,
                flapping: tuning.data.stats.flapping,
                shortLived: tuning.data.stats.shortLived,
              })}
            </p>
            {apply.isSuccess && <Alert tone="success">{t("tuningApplied")}</Alert>}
            {apply.isError && <Alert tone="error">{errorMessage(apply.error)}</Alert>}
            {tuning.data.suggestions.length === 0 ? (
              <p>{t("tuningNone")}</p>
            ) : (
              <ul className="grid gap-3">
                {tuning.data.suggestions.map((s) => (
                  <li key={s.id} className="grid gap-2 rounded-md border p-3">
                    <p className="font-medium">{s.title}</p>
                    <p className="text-muted-foreground">{s.reason}</p>
                    {canEdit && (
                      <div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={apply.isPending}
                          onClick={() => apply.mutate(s)}
                        >
                          {t("tuningApply")}
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* Overview: monitors whose alerts were noisiest, with the top suggestion. Hidden when all is quiet. */
export function NoisyMonitors({ ws }: { ws: string }) {
  const t = useTranslations("insights");
  const noisy = useNoisiest(ws);
  const rows = (noisy.data ?? []).filter((m) => m.suggestions.length > 0).slice(0, 5);
  if (rows.length === 0) return null;
  return (
    <section className="grid gap-2" aria-labelledby="noisy-monitors">
      <h2 id="noisy-monitors" className="text-base font-semibold">
        {t("noisyTitle")}
      </h2>
      <ul className="divide-y rounded-lg border">
        {rows.map((m) => (
          <li key={m.monitorId} className="grid gap-0.5 px-3 py-2 text-sm">
            <Link
              href={workspaceHref(ws, `monitors/${m.monitorId}`)}
              className="font-medium hover:underline"
            >
              {m.name}
            </Link>
            <span className="text-muted-foreground">
              {t("noisySummary", {
                noisy: m.stats.falseAlarms + m.stats.flapping + m.stats.shortLived,
                incidents: m.stats.incidents,
              })}{" "}
              · {m.suggestions[0]?.title}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
