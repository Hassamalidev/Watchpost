/*
 * Billing (PRODUCT.md §14): the plan and what happens next, usage against it, the plan picker, SMS
 * and voice credits, invoices through the customer portal, and pause or cancel. Everyone in the
 * workspace can read it; owners, admins and billing members can change it (the API enforces this).
 */
"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useWorkspace } from "@/components/app/workspace-context";
import { Alert } from "@/components/ui/alert";
import { Loading } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api";
import { billingKeys, useBilling } from "../api";
import { CreditsCard } from "./credits-card";
import { CancelCard, InvoicesCard } from "./manage-card";
import { PlanPicker } from "./plan-picker";
import { PlanSummary } from "./plan-summary";
import { UsageCard } from "./usage-card";

const MANAGER_ROLES = ["owner", "admin", "billing"];
const SLOW_ACTIVATION_MS = 60_000;

export function BillingPage() {
  const t = useTranslations("billing");
  const workspace = useWorkspace();
  const ws = workspace.id;
  const canManage = MANAGER_ROLES.includes(workspace.role);
  const client = useQueryClient();
  /* After checkout the plan changes when Paddle's webhook is processed; poll until it shows. */
  const [activating, setActivating] = React.useState<"no" | "yes" | "slow">("no");
  const billing = useBilling(ws, activating !== "no");
  const subscribed = billing.data !== undefined && billing.data.subscription !== null;

  React.useEffect(() => {
    if (activating === "no") return;
    if (subscribed) {
      setActivating("no");
      void client.invalidateQueries({ queryKey: billingKeys.usage(ws) });
      void client.invalidateQueries({ queryKey: billingKeys.credits(ws) });
      return;
    }
    if (activating === "slow") return;
    const timer = setTimeout(() => setActivating("slow"), SLOW_ACTIVATION_MS);
    return () => clearTimeout(timer);
  }, [activating, subscribed, client, ws]);

  return (
    <div className="grid max-w-6xl gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      {!canManage && <Alert tone="info">{t("readOnly")}</Alert>}
      {activating !== "no" && (
        <Alert tone="info">{activating === "slow" ? t("activatingSlow") : t("activating")}</Alert>
      )}
      {billing.isError && <Alert tone="error">{errorMessage(billing.error)}</Alert>}
      {billing.data === undefined ? (
        !billing.isError && <Loading rows={4} />
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <PlanSummary ws={ws} state={billing.data} canManage={canManage} />
            <UsageCard ws={ws} state={billing.data} />
          </div>
          <PlanPicker
            ws={ws}
            state={billing.data}
            canManage={canManage}
            onCheckoutCompleted={() => setActivating("yes")}
          />
          <CreditsCard ws={ws} state={billing.data} canManage={canManage} />
          {canManage && (
            <div className="grid gap-4 lg:grid-cols-2">
              <InvoicesCard ws={ws} state={billing.data} />
              <CancelCard ws={ws} state={billing.data} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
