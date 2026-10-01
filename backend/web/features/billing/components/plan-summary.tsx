/*
 * The plan the workspace is on and what happens next: trial end, renewal, a failed payment's grace
 * period, a scheduled cancel or pause, or a downgrade waiting for the paid period to end. Every state
 * says the date and the consequence in words.
 */
"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { errorMessage } from "@/lib/api";
import { billingApi, billingKeys, type BillingState } from "../api";
import { daysUntil, formatDate } from "../plan";

export function PlanSummary({
  ws,
  state,
  canManage,
}: {
  ws: string;
  state: BillingState;
  canManage: boolean;
}) {
  const t = useTranslations("billing");
  const client = useQueryClient();
  const resume = useMutation({
    mutationFn: () => billingApi.resume(ws),
    onSuccess: (next) => client.setQueryData(billingKeys.state(ws), next),
  });
  const { entitlements: e, subscription: sub } = state;
  const nameOf = (key: string) => state.catalog.plans.find((p) => p.key === key)?.name ?? key;

  const lines: string[] = [];
  if (e.source === "trial" && e.trialEndsAt !== null) {
    lines.push(
      sub === null
        ? t("sourceTrial", {
            plan: e.planName,
            date: formatDate(e.trialEndsAt),
            days: daysUntil(e.trialEndsAt),
          })
        : t("trialWithSubscription", {
            paid: nameOf(sub.plan),
            plan: e.planName,
            date: formatDate(e.trialEndsAt),
          }),
    );
  } else if (e.source === "grace" && e.graceEndsAt !== null) {
    lines.push(t("sourceGrace", { plan: e.planName, date: formatDate(e.graceEndsAt) }));
  } else if (e.source === "subscription" && sub !== null) {
    lines.push(
      sub.currentPeriodEnd === null || sub.scheduledChange !== null
        ? t("sourceSubscriptionNoDate", { interval: sub.interval })
        : t("sourceSubscription", {
            interval: sub.interval,
            date: formatDate(sub.currentPeriodEnd),
          }),
    );
  } else if (sub?.status === "paused") {
    lines.push(t("paused"));
  } else {
    lines.push(t("sourceFree"));
  }
  if (sub?.scheduledChange?.action === "cancel") {
    lines.push(t("scheduledCancel", { date: formatDate(sub.scheduledChange.effectiveAt) }));
  }
  if (sub?.scheduledChange?.action === "pause") {
    lines.push(t("scheduledPause", { date: formatDate(sub.scheduledChange.effectiveAt) }));
  }
  if (sub?.downgrade) {
    lines.push(
      t("downgradePending", {
        to: nameOf(sub.plan),
        from: nameOf(sub.downgrade.from),
        date: formatDate(sub.downgrade.effectiveAt),
      }),
    );
  }

  const canUndo = sub?.scheduledChange != null && sub.scheduledChange.action !== "resume";
  const canResume = sub?.status === "paused" && sub.scheduledChange === null;

  return (
    <Card aria-labelledby="billing-plan-heading">
      <CardHeader>
        <CardTitle id="billing-plan-heading">{t("planTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <p className="text-xl font-semibold">{t("planOn", { plan: e.planName })}</p>
        {lines.map((line) => (
          <p key={line} className={e.source === "grace" ? "text-status-down" : undefined}>
            {line}
          </p>
        ))}
        {state.isFoundingCustomer && <p className="text-muted-foreground">{t("founding")}</p>}
        {state.foundingOfferAvailable && (
          <p className="text-muted-foreground">{t("foundingOffer")}</p>
        )}
        {resume.isError && <Alert tone="error">{errorMessage(resume.error)}</Alert>}
        {canManage && (canUndo || canResume) && (
          <div>
            <Button disabled={resume.isPending} onClick={() => resume.mutate()}>
              {canUndo ? t("keep") : t("resume")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
