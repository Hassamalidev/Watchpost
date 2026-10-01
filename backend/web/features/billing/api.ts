/*
 * Typed calls and hooks for billing (PRODUCT.md §11): the plan and what it allows, usage against it,
 * SMS and voice credits, and the actions on the billing page.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import type {
  BillingInterval,
  BillingState,
  CancelReason,
  CheckoutSession,
  CreditPack,
  CreditsState,
  MonitorUsage,
  PaidPlanKey,
} from "@app/shared";
import { api, wsPath } from "@/lib/api";

export type { BillingState, CreditsState, MonitorUsage };

const post = <T>(ws: string, path: string, body: object = {}) =>
  api<T>(wsPath(ws, path), { method: "POST", body });

export const billingApi = {
  state: (ws: string) => api<BillingState>(wsPath(ws, "/billing")),
  credits: (ws: string) => api<CreditsState>(wsPath(ws, "/credits")),
  usage: (ws: string) => api<MonitorUsage>(wsPath(ws, "/monitor-usage")),
  checkout: (ws: string, plan: PaidPlanKey, interval: BillingInterval) =>
    post<CheckoutSession>(ws, "/billing/checkout", { plan, interval }),
  changePlan: (ws: string, plan: PaidPlanKey, interval: BillingInterval) =>
    post<BillingState>(ws, "/billing/plan", { plan, interval }),
  buyCredits: (ws: string, credits: CreditPack) =>
    post<{ status: string }>(ws, "/billing/credits", { credits }),
  cancel: (ws: string, reason: CancelReason, comment: string) =>
    post<BillingState>(ws, "/billing/cancel", {
      reason,
      ...(comment.trim() === "" ? {} : { comment: comment.trim() }),
    }),
  pause: (ws: string) => post<BillingState>(ws, "/billing/pause"),
  resume: (ws: string) => post<BillingState>(ws, "/billing/resume"),
  portal: (ws: string) => post<{ url: string }>(ws, "/billing/portal"),
};

export const billingKeys = {
  state: (ws: string) => ["billing", ws] as const,
  credits: (ws: string) => ["credits", ws] as const,
  usage: (ws: string) => ["monitor-usage", ws] as const,
};

export function useBilling(ws: string, refetchMs = 60_000) {
  return useQuery({
    queryKey: billingKeys.state(ws),
    queryFn: () => billingApi.state(ws),
    refetchInterval: refetchMs,
  });
}

export function useCredits(ws: string, fast = false) {
  return useQuery({
    queryKey: billingKeys.credits(ws),
    queryFn: () => billingApi.credits(ws),
    refetchInterval: fast ? 2_000 : 60_000,
  });
}

export function useMonitorUsage(ws: string) {
  return useQuery({
    queryKey: billingKeys.usage(ws),
    queryFn: () => billingApi.usage(ws),
    refetchInterval: 60_000,
  });
}
