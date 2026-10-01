/*
 * The likely cause of a failure and the first things to check, in plain language, with how widely it
 * was confirmed. Worded as "likely": it's a rule table, not a diagnosis.
 */
"use client";

import { useTranslations } from "next-intl";
import { Lightbulb } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Explanation } from "../api";

export function ExplanationCard({
  explanation,
  failingRegions,
  regionCount,
}: {
  explanation: Explanation;
  failingRegions: string[];
  regionCount: number | null;
}) {
  const t = useTranslations("insights");
  return (
    <Card className="border-brand/40">
      <CardHeader>
        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-brand">
          <Lightbulb aria-hidden className="size-4" />
          {t("likelyCause")}
        </p>
        <CardTitle className="text-lg">{explanation.headline}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <p>{explanation.detail}</p>
        {failingRegions.length > 0 && regionCount !== null && regionCount > 0 && (
          <p className="text-muted-foreground">
            {t("confirmedFrom", {
              count: failingRegions.length,
              total: regionCount,
              regions: failingRegions.join(", "),
            })}{" "}
            {explanation.scope === "everywhere"
              ? t("scopeEverywhere")
              : explanation.scope === "some-regions"
                ? t("scopeSome")
                : ""}
          </p>
        )}
        {explanation.nextSteps.length > 0 && (
          <div className="grid gap-2">
            <h3 className="font-medium">{t("checkFirst")}</h3>
            <ol className="grid list-decimal gap-1.5 pl-5">
              {explanation.nextSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
