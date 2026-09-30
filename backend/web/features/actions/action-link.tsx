/*
 * Confirmation page for email action links (PRODUCT.md §10). Opening the link changes nothing (mail
 * scanners prefetch links); the button performs the action once.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { api, errorMessage } from "@/lib/api";

interface Preview {
  action: "acknowledge" | "resolve";
  recipient: string;
  used: boolean;
  incident: { number: number; title: string; status: string };
}

interface Outcome {
  action: "acknowledge" | "resolve";
  result: "done" | "already";
  incident: { number: number; title: string; status: string };
}

export function ActionLink({ token }: { token: string }) {
  const t = useTranslations("actionLink");
  const path = `/api/actions/${encodeURIComponent(token)}`;
  const preview = useQuery({
    queryKey: ["action-link", token],
    queryFn: () => api<Preview>(path),
    retry: false,
  });
  const perform = useMutation({
    mutationFn: () => api<Outcome>(path, { method: "POST", body: {} }),
  });

  let body: React.ReactNode;
  if (preview.isPending) {
    body = <p className="text-muted-foreground">{t("loading")}</p>;
  } else if (preview.isError) {
    body = <Alert tone="error">{errorMessage(preview.error)}</Alert>;
  } else if (perform.isSuccess) {
    const { incident, result, action } = perform.data;
    body = (
      <Alert tone="success">
        {result === "already"
          ? t("already", { number: incident.number, status: incident.status })
          : action === "acknowledge"
            ? t("doneAcknowledge", { number: incident.number })
            : t("doneResolve", { number: incident.number })}
      </Alert>
    );
  } else {
    const { incident, action, recipient, used } = preview.data;
    body = (
      <div className="grid gap-4">
        <div>
          <h2 className="text-lg font-semibold">
            {action === "acknowledge"
              ? t("confirmAcknowledge", { number: incident.number })
              : t("confirmResolve", { number: incident.number })}
          </h2>
          <p className="mt-1">{incident.title}</p>
          <p className="mt-2 text-sm text-muted-foreground">{t("for", { email: recipient })}</p>
        </div>
        {perform.isError && <Alert tone="error">{errorMessage(perform.error)}</Alert>}
        {used ? (
          <Alert tone="info">{t("used")}</Alert>
        ) : (
          <Button className="h-11" disabled={perform.isPending} onClick={() => perform.mutate()}>
            {perform.isPending
              ? t("working")
              : action === "acknowledge"
                ? t("acknowledge")
                : t("resolve")}
          </Button>
        )}
      </div>
    );
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <h1 className="text-xl font-semibold">{t("title")}</h1>
      </CardHeader>
      <CardContent className="grid gap-4">
        {body}
        <Link href="/w" className="text-sm underline">
          {t("open")}
        </Link>
      </CardContent>
    </Card>
  );
}
