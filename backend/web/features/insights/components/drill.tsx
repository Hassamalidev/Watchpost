/*
 * Alert drill: opens a real, clearly labelled incident so every route, escalation and channel is
 * exercised end to end. Admins only; asks first because it pages people.
 */
"use client";

import Link from "next/link";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Siren } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { errorMessage } from "@/lib/api";
import { workspaceHref } from "@/lib/navigation";
import { insightsApi } from "../api";

export function DrillCard({ ws }: { ws: string }) {
  const t = useTranslations("insights");
  const drill = useMutation({ mutationFn: () => insightsApi.drill(ws) });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("drillTitle")}</CardTitle>
        <CardDescription>{t("drillIntro")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {drill.isError && <Alert tone="error">{errorMessage(drill.error)}</Alert>}
        {drill.isSuccess ? (
          <Alert tone="success">
            {t("drillStarted", { number: drill.data.number })}{" "}
            <Link href={workspaceHref(ws, `incidents/${drill.data.number}`)} className="underline">
              {t("drillOpen")}
            </Link>
          </Alert>
        ) : (
          <div>
            <Button
              variant="outline"
              disabled={drill.isPending}
              onClick={() => {
                if (window.confirm(t("drillConfirm"))) drill.mutate();
              }}
            >
              <Siren aria-hidden />
              {drill.isPending ? t("drillStarting") : t("drillStart")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
