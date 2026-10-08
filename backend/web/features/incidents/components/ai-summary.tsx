/*
 * The AI explanation of an incident (PRODUCT.md §6.9, §9.10): always labeled "AI", with what it
 * rests on said plainly, and a way to say whether it helped. It arrives a few seconds after the
 * incident opens and never replaces the alert or the rule-based explanation.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Sparkles, ThumbsDown, ThumbsUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { incidentsApi, type AiFeedback, type AiSummary } from "../api";

export function AiSummaryCard({
  ws,
  summary,
  canRate,
}: {
  ws: string;
  summary: AiSummary;
  canRate: boolean;
}) {
  const t = useTranslations("incidents.ai");
  const client = useQueryClient();
  const key = ["ai-feedback", ws, summary.generationId] as const;
  const feedback = useQuery({
    queryKey: key,
    queryFn: async () => (await incidentsApi.aiFeedback(ws, summary.generationId)).feedback,
  });
  const rate = useMutation({
    mutationFn: (value: AiFeedback | null) =>
      incidentsApi.setAiFeedback(ws, summary.generationId, value),
    onSuccess: (saved) => client.setQueryData(key, saved.feedback),
  });
  const current = feedback.data ?? null;
  /* Pressing the chosen thumb again takes the rating back. */
  const toggle = (value: AiFeedback) => rate.mutate(current === value ? null : value);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles aria-hidden className="size-4" />
          {t("title")}
          <span className="rounded border px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
            {t("label")}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <p className="text-base font-medium">{summary.headline}</p>
        <p>{summary.likelyCause}</p>
        {summary.nextChecks.length > 0 && (
          <div>
            <p className="font-medium">{t("checkFirst")}</p>
            <ol className="mt-1 grid list-decimal gap-1 pl-5">
              {summary.nextChecks.map((check) => (
                <li key={check}>{check}</li>
              ))}
            </ol>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {t(`confidence.${summary.confidence}`)}. {t("disclaimer")}
        </p>
        {canRate && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("helpful")}</span>
            <Button
              size="sm"
              variant={current === "up" ? "default" : "outline"}
              aria-pressed={current === "up"}
              disabled={rate.isPending}
              onClick={() => toggle("up")}
            >
              <ThumbsUp aria-hidden />
              {t("up")}
            </Button>
            <Button
              size="sm"
              variant={current === "down" ? "default" : "outline"}
              aria-pressed={current === "down"}
              disabled={rate.isPending}
              onClick={() => toggle("down")}
            >
              <ThumbsDown aria-hidden />
              {t("down")}
            </Button>
            {current !== null && (
              <span role="status" className="text-xs text-muted-foreground">
                {t("thanks")}
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
