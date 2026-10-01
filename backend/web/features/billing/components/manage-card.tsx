/*
 * Invoices and the payment method live in Paddle's customer portal; pausing and canceling happen
 * here. Canceling asks why and offers a pause first. Both take effect at the end of the period the
 * customer already paid for, and both can be undone until then (the plan summary shows the button).
 */
"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { CANCEL_REASONS, type CancelReason } from "@app/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Select, Textarea } from "@/components/ui/input";
import { errorMessage } from "@/lib/api";
import { billingApi, billingKeys, type BillingState } from "../api";

export function InvoicesCard({ ws, state }: { ws: string; state: BillingState }) {
  const t = useTranslations("billing");
  const portal = useMutation({
    mutationFn: async () => {
      /*
       * Opened during the click so popup blockers allow it; pointed at the portal once the API
       * answers. Portal links are temporary, so one is made per visit.
       */
      const tab = window.open("about:blank", "_blank");
      try {
        const { url } = await billingApi.portal(ws);
        if (tab === null) {
          window.location.assign(url);
        } else {
          tab.opener = null;
          tab.location.replace(url);
        }
      } catch (err) {
        tab?.close();
        throw err;
      }
    },
  });
  return (
    <Card aria-labelledby="billing-invoices-heading">
      <CardHeader>
        <CardTitle id="billing-invoices-heading">{t("invoicesTitle")}</CardTitle>
        <CardDescription>{t("invoicesIntro")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {portal.isError && <Alert tone="error">{errorMessage(portal.error)}</Alert>}
        {state.portalAvailable ? (
          <div>
            <Button variant="outline" disabled={portal.isPending} onClick={() => portal.mutate()}>
              {t("openPortal")}
            </Button>
          </div>
        ) : (
          <p className="text-muted-foreground">{t("portalNone")}</p>
        )}
      </CardContent>
    </Card>
  );
}

export function CancelCard({ ws, state }: { ws: string; state: BillingState }) {
  const t = useTranslations("billing");
  const client = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState<CancelReason | "">("");
  const [comment, setComment] = React.useState("");
  const done = (next: BillingState) => {
    client.setQueryData(billingKeys.state(ws), next);
    setOpen(false);
  };
  const cancel = useMutation({
    mutationFn: (why: CancelReason) => billingApi.cancel(ws, why, comment),
    onSuccess: done,
  });
  const pause = useMutation({ mutationFn: () => billingApi.pause(ws), onSuccess: done });

  const sub = state.subscription;
  /* Nothing to cancel, or a cancel or pause is already scheduled (the summary offers to undo it). */
  if (sub === null || sub.scheduledChange !== null) return null;
  const busy = cancel.isPending || pause.isPending;
  /* A paused subscription isn't being billed, so canceling it takes effect at once. */
  const paused = sub.status === "paused";

  return (
    <Card aria-labelledby="billing-manage-heading">
      <CardHeader>
        <CardTitle id="billing-manage-heading">
          {open ? t("cancelHeading") : t("manageTitle")}
        </CardTitle>
        {open && (
          <CardDescription>{paused ? t("cancelIntroPaused") : t("cancelIntro")}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {cancel.isError && <Alert tone="error">{errorMessage(cancel.error)}</Alert>}
        {pause.isError && <Alert tone="error">{errorMessage(pause.error)}</Alert>}
        {!open ? (
          <div>
            <Button variant="outline" onClick={() => setOpen(true)}>
              {t("cancelStart")}
            </Button>
          </div>
        ) : (
          <form
            className="grid max-w-xl gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (reason !== "") cancel.mutate(reason);
            }}
          >
            <Field label={t("cancelReason")} htmlFor="cancel-reason" hint={t("cancelReasonHint")}>
              <Select
                id="cancel-reason"
                required
                value={reason}
                onChange={(event) => setReason(event.target.value as CancelReason | "")}
              >
                <option value="" disabled>
                  —
                </option>
                {CANCEL_REASONS.map((value) => (
                  <option key={value} value={value}>
                    {t(`cancelReasons.${value}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("cancelComment")} htmlFor="cancel-comment">
              <Textarea
                id="cancel-comment"
                maxLength={1_000}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
              />
            </Field>
            {sub.status === "active" && (
              <div className="grid gap-2 rounded-md border p-3">
                <p className="text-muted-foreground">{t("pauseHint")}</p>
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => pause.mutate()}
                  >
                    {t("pauseStart")}
                  </Button>
                </div>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="outline" disabled={busy || reason === ""}>
                {paused ? t("cancelConfirmNow") : t("cancelConfirm")}
              </Button>
              <Button type="button" disabled={busy} onClick={() => setOpen(false)}>
                {t("cancelBack")}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
