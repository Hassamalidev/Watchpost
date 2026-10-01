/* Plan cards with a monthly/annual switch; each card starts sign-up with that plan selected. */
"use client";

import * as React from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  MARKETING_PLANS,
  PLAN_FEATURE_KEYS,
  formatPlanPrice,
  type MarketingPlan,
} from "@/features/marketing/plans";

type Billing = "monthly" | "annual";

export const signupHref = (plan: MarketingPlan, billing: Billing) =>
  plan.key === "free" ? "/signup" : `/signup?plan=${plan.key}&billing=${billing}`;

export function PlanPicker() {
  const t = useTranslations("marketing");
  const [billing, setBilling] = React.useState<Billing>("monthly");

  return (
    <div className="grid gap-6">
      <div
        role="group"
        aria-label={t("billingPeriod")}
        className="mx-auto inline-flex rounded-md border p-1"
      >
        {(["monthly", "annual"] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={billing === option}
            onClick={() => setBilling(option)}
            className={cn(
              "rounded-sm px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2",
              billing === option
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(option === "monthly" ? "billedMonthly" : "billedAnnually")}
          </button>
        ))}
      </div>

      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {MARKETING_PLANS.map((plan) => {
          const name = t(`plans.${plan.key}.name`);
          return (
            <li
              key={plan.key}
              className={cn(
                "flex flex-col gap-4 rounded-lg border bg-card p-5 text-card-foreground shadow-xs",
                plan.highlighted && "border-brand",
              )}
            >
              <div className="grid gap-1">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-base font-semibold">{name}</h3>
                  {plan.highlighted && (
                    <span className="rounded-full border border-brand px-2 py-0.5 text-xs font-medium text-brand">
                      {t("mostPopular")}
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">{t(`plans.${plan.key}.tagline`)}</p>
              </div>
              <p>
                <span className="text-3xl font-semibold tracking-tight">
                  {formatPlanPrice(billing === "annual" ? plan.annual : plan.monthly)}
                </span>{" "}
                <span className="text-sm text-muted-foreground">
                  {plan.monthly === 0
                    ? t("priceForever")
                    : t(billing === "annual" ? "pricePerMonthAnnual" : "pricePerMonth")}
                </span>
              </p>
              <ul className="grid gap-2 text-sm">
                {PLAN_FEATURE_KEYS.map((feature) => (
                  <li key={feature} className="flex items-start gap-2">
                    <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-status-up" />
                    <span>{t(`plans.${plan.key}.${feature}`)}</span>
                  </li>
                ))}
              </ul>
              <Link
                href={signupHref(plan, billing)}
                className={cn(
                  buttonVariants({ variant: plan.highlighted ? "default" : "outline" }),
                  "mt-auto",
                )}
              >
                {plan.key === "free" ? t("startFree") : t("choosePlan", { plan: name })}
              </Link>
            </li>
          );
        })}
      </ul>
      <p className="text-center text-sm text-muted-foreground">{t("pricingNote")}</p>
    </div>
  );
}
