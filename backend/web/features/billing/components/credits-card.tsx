/*
 * SMS and voice credits: what is left, where it came from (this month's allowance or packs), a
 * low-balance warning, credit packs charged to the saved payment method, and recent activity.
 * A pack's credits arrive with Paddle's webhook, so the card polls for a moment after a purchase.
 */
"use client";

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { CreditPack } from "@app/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loading } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { billingApi, useCredits, type BillingState } from "../api";
import { formatUsd } from "../plan";

const WAIT_FOR_CREDITS_MS = 45_000;

export function CreditsCard({
  ws,
  state,
  canManage,
}: {
  ws: string;
  state: BillingState;
  canManage: boolean;
}) {
  const t = useTranslations("billing");
  /* While waiting for a pack: the purchased balance before the purchase. */
  const [waitingFrom, setWaitingFrom] = React.useState<number | null>(null);
  const [bought, setBought] = React.useState(false);
  const credits = useCredits(ws, waitingFrom !== null);
  const purchased = credits.data?.purchased;

  React.useEffect(() => {
    if (waitingFrom === null) return;
    if (purchased !== undefined && purchased > waitingFrom) {
      setWaitingFrom(null);
      setBought(true);
      return;
    }
    const timer = setTimeout(() => setWaitingFrom(null), WAIT_FOR_CREDITS_MS);
    return () => clearTimeout(timer);
  }, [waitingFrom, purchased]);

  const buy = useMutation({
    mutationFn: (pack: CreditPack) => billingApi.buyCredits(ws, pack),
    onMutate: () => setBought(false),
    onSuccess: () => setWaitingFrom(purchased ?? 0),
  });
  const active = state.subscription?.status === "active";

  return (
    <Card aria-labelledby="billing-credits-heading">
      <CardHeader>
        <CardTitle id="billing-credits-heading">{t("creditsTitle")}</CardTitle>
        <CardDescription>{t("creditsIntro")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        {credits.data === undefined ? (
          <Loading rows={2} />
        ) : (
          <>
            <div className="grid gap-1">
              <p className="text-xl font-semibold">
                {t("creditsTotal", { count: credits.data.total })}
              </p>
              {credits.data.monthlyAllowance > 0 && (
                <p className="text-muted-foreground">
                  {t("creditsIncluded", {
                    count: credits.data.included,
                    allowance: credits.data.monthlyAllowance,
                  })}
                </p>
              )}
              {credits.data.purchased > 0 && (
                <p className="text-muted-foreground">
                  {t("creditsPurchased", { count: credits.data.purchased })}
                </p>
              )}
              {credits.data.monthlyAllowance === 0 && credits.data.total === 0 && (
                <p className="text-muted-foreground">{t("creditsNone")}</p>
              )}
            </div>
            {credits.data.lowBalance && <Alert tone="error">{t("creditsLow")}</Alert>}
            {buy.isError && <Alert tone="error">{errorMessage(buy.error)}</Alert>}
            {waitingFrom !== null && <Alert tone="info">{t("buying")}</Alert>}
            {bought && <Alert tone="success">{t("bought")}</Alert>}
            {canManage && (
              <div className="grid gap-2">
                <div className="flex flex-wrap gap-2">
                  {state.catalog.creditPacks.map((pack) => (
                    <Button
                      key={pack.credits}
                      variant="outline"
                      disabled={
                        !active || !pack.purchasable || buy.isPending || waitingFrom !== null
                      }
                      onClick={() => {
                        const price = formatUsd(pack.usd);
                        if (window.confirm(t("confirmBuy", { credits: pack.credits, price }))) {
                          buy.mutate(pack.credits);
                        }
                      }}
                    >
                      {t("buyPack", { credits: pack.credits, price: formatUsd(pack.usd) })}
                    </Button>
                  ))}
                </div>
                {!active && <p className="text-xs text-muted-foreground">{t("buyNeedsPlan")}</p>}
              </div>
            )}
            <div className="grid gap-2">
              <h3 className="font-medium">{t("historyTitle")}</h3>
              {credits.data.recent.length === 0 ? (
                <p className="text-muted-foreground">{t("historyEmpty")}</p>
              ) : (
                <ul className="divide-y rounded-lg border">
                  {credits.data.recent.map((entry) => (
                    <li key={entry.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                      <span className="min-w-0 flex-1">
                        {t(`reason.${entry.reason as "grant"}`)}
                      </span>
                      <span
                        className={cn(
                          "font-mono text-sm",
                          entry.delta > 0 ? "text-status-up" : "text-foreground",
                        )}
                      >
                        {entry.delta > 0 ? `+${entry.delta}` : entry.delta}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {formatDateTime(entry.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
