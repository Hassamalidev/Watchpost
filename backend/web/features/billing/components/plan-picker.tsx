/*
 * Plan picker: the four plans with what each allows, monthly or yearly prices, and the one action that
 * applies to each (subscribe, upgrade, move down, switch to yearly). A new subscription opens Paddle's
 * checkout; changes to an existing one are confirmed in words first, because an upgrade charges the
 * saved payment method at once.
 */
"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";
import { CircleCheck } from "lucide-react";
import type { BillingInterval, CatalogPlan, PaidPlanKey } from "@app/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SELECTED_PLAN_STORAGE_KEY, parseSelectedPlan } from "@/features/marketing/plans";
import { billingApi, billingKeys, type BillingState } from "../api";
import { openCheckout } from "../paddle";
import { formatCheckInterval, formatUsd, planAction, type PlanAction } from "../plan";

const BLOCKED: Partial<
  Record<
    PlanAction,
    "blockedStatus" | "blockedPastDue" | "blockedPending" | "blockedYearly" | "blockedInterval"
  >
> = {
  blocked_status: "blockedStatus",
  blocked_past_due: "blockedPastDue",
  blocked_pending: "blockedPending",
  blocked_yearly: "blockedYearly",
  blocked_interval: "blockedInterval",
};

function PlanLimits({ plan }: { plan: CatalogPlan }) {
  const t = useTranslations("billing");
  const { limits } = plan;
  const lines = [
    t("limitMonitors", { count: limits.monitors }),
    t("limitHeartbeats", { count: limits.heartbeats }),
    t("limitInterval", { interval: formatCheckInterval(limits.minIntervalSeconds) }),
    t("limitRegions", { count: limits.regionsPerMonitor }),
    limits.members === "unlimited"
      ? t("limitMembersUnlimited")
      : t("limitMembers", { count: limits.members }),
    t("limitHistory", { days: limits.historyDays }),
    limits.monthlyCredits > 0
      ? t("limitCredits", { count: limits.monthlyCredits })
      : t("limitNoCredits"),
  ];
  return (
    <ul className="grid gap-1 text-sm text-muted-foreground">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

export function PlanPicker({
  ws,
  state,
  canManage,
  onCheckoutCompleted,
}: {
  ws: string;
  state: BillingState;
  canManage: boolean;
  onCheckoutCompleted: () => void;
}) {
  const t = useTranslations("billing");
  const client = useQueryClient();
  const { resolvedTheme } = useTheme();
  const [interval, setInterval] = React.useState<BillingInterval>(
    state.subscription?.interval ?? "month",
  );

  /* The plan picked on the public site before sign-up: start on its billing period and point at it. */
  const [chosen, setChosen] = React.useState<PaidPlanKey | null>(null);
  const hasSubscription = state.subscription !== null;
  React.useEffect(() => {
    try {
      if (hasSubscription) {
        window.localStorage.removeItem(SELECTED_PLAN_STORAGE_KEY);
        return;
      }
      const selected = parseSelectedPlan(window.localStorage.getItem(SELECTED_PLAN_STORAGE_KEY));
      if (!selected) return;
      setChosen(selected.plan);
      setInterval(selected.interval);
    } catch {
      /* Storage can be blocked; the picker works without the hint. */
    }
  }, [hasSubscription]);

  const subscribe = useMutation({
    mutationFn: async (plan: PaidPlanKey) => {
      if (state.paddle === null) throw new Error(t("unavailable"));
      const session = await billingApi.checkout(ws, plan, interval);
      await openCheckout({
        paddle: state.paddle,
        session,
        theme: resolvedTheme === "dark" ? "dark" : "light",
        onEvent: (event) => {
          if (event.name === "checkout.completed") onCheckoutCompleted();
        },
      });
    },
  });
  const change = useMutation({
    mutationFn: (plan: PaidPlanKey) => billingApi.changePlan(ws, plan, interval),
    onSuccess: (next) => {
      client.setQueryData(billingKeys.state(ws), next);
      void client.invalidateQueries({ queryKey: billingKeys.usage(ws) });
      void client.invalidateQueries({ queryKey: billingKeys.credits(ws) });
    },
  });
  const busy = subscribe.isPending || change.isPending;

  function priceLine(plan: CatalogPlan): string {
    if (plan.key === "free") return t("free");
    return interval === "month"
      ? t("perMonth", { price: formatUsd(plan.monthlyUsd) })
      : t("perMonthYearly", {
          price: formatUsd(plan.annualMonthlyUsd),
          total: formatUsd(plan.annualMonthlyUsd * 12),
        });
  }

  function action(plan: CatalogPlan): React.ReactNode {
    const kind = planAction(state, plan, interval);
    if (kind === "current") {
      return (
        <p className="inline-flex items-center gap-1 text-sm font-medium">
          <CircleCheck aria-hidden className="size-4" />
          {t("current")}
        </p>
      );
    }
    if (kind === "free") {
      return state.subscription === null ? null : (
        <p className="text-xs text-muted-foreground">{t("freeHow")}</p>
      );
    }
    if (kind === "unavailable") {
      return <p className="text-xs text-muted-foreground">{t("unavailable")}</p>;
    }
    const blocked = BLOCKED[kind];
    if (blocked !== undefined) {
      return <p className="text-xs text-muted-foreground">{t(blocked)}</p>;
    }
    if (!canManage || plan.key === "free") return null;
    const key = plan.key;
    if (kind === "subscribe") {
      return (
        <Button disabled={busy} onClick={() => subscribe.mutate(key)}>
          {t("subscribe", { plan: plan.name })}
        </Button>
      );
    }
    const downgrade = kind === "downgrade";
    const restore = kind === "restore";
    return (
      <Button
        variant={downgrade ? "outline" : "default"}
        disabled={busy}
        onClick={() => {
          const question = downgrade
            ? t("confirmDowngrade", { plan: plan.name })
            : restore
              ? t("confirmRestore", { plan: plan.name })
              : t("confirmUpgrade", { plan: plan.name });
          if (window.confirm(question)) change.mutate(key);
        }}
      >
        {kind === "switch_yearly"
          ? t("switchYearly")
          : downgrade
            ? t("downgrade", { plan: plan.name })
            : restore
              ? t("restore", { plan: plan.name })
              : t("upgrade", { plan: plan.name })}
      </Button>
    );
  }

  return (
    <section className="grid gap-3" aria-labelledby="billing-plans-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="billing-plans-heading" className="text-base font-semibold">
          {t("plansTitle")}
        </h2>
        <fieldset className="flex items-center gap-4 text-sm">
          <legend className="sr-only">{t("interval")}</legend>
          {(["month", "year"] as const).map((value) => (
            <label key={value} className="flex items-center gap-1.5">
              <input
                type="radio"
                name="billing-interval"
                value={value}
                checked={interval === value}
                onChange={() => setInterval(value)}
              />
              {value === "month" ? t("intervalMonth") : t("intervalYear")}
            </label>
          ))}
        </fieldset>
      </div>
      {subscribe.isError && <Alert tone="error">{errorMessage(subscribe.error)}</Alert>}
      {change.isError && <Alert tone="error">{errorMessage(change.error)}</Alert>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {state.catalog.plans.map((plan) => {
          const current = planAction(state, plan, interval) === "current";
          return (
            <Card key={plan.key} className={cn("flex flex-col", current && "border-brand")}>
              <CardHeader>
                <h3 className="text-base font-semibold">{plan.name}</h3>
                {chosen === plan.key && !current && !hasSubscription && (
                  <p className="text-xs font-medium text-brand">{t("chosenOnSite")}</p>
                )}
                <p className="text-sm font-medium">{priceLine(plan)}</p>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col justify-between gap-4">
                <PlanLimits plan={plan} />
                <div>{action(plan)}</div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
