/*
 * Requiring two-factor sign-in for a workspace (PRODUCT.md §6.11, Business): once on, a member
 * without it can't open the workspace until they have set it up.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { api, errorMessage, wsPath } from "@/lib/api";

interface Settings {
  requireTwoFactor: boolean;
}

export function RequireTwoFactor({ ws }: { ws: string }) {
  const t = useTranslations("settings.requireTwoFactor");
  const client = useQueryClient();
  const key = ["workspace-security", ws] as const;
  const settings = useQuery({
    queryKey: key,
    queryFn: () => api<Settings>(wsPath(ws, "/settings")),
  });
  const change = useMutation({
    mutationFn: (requireTwoFactor: boolean) =>
      api<Settings>(wsPath(ws, "/settings"), { method: "PATCH", body: { requireTwoFactor } }),
    onSuccess: (saved) => client.setQueryData(key, saved),
  });
  if (settings.data === undefined) return null;
  const on = settings.data.requireTwoFactor;
  return (
    <section className="grid gap-2 rounded-lg border p-4" aria-labelledby="require-2fa-heading">
      <h2 id="require-2fa-heading" className="text-base font-semibold">
        {t("title")}
      </h2>
      <p className="text-sm text-muted-foreground">{t("intro")}</p>
      {change.isError && <Alert tone="error">{errorMessage(change.error)}</Alert>}
      <p className="text-sm font-medium">{on ? t("isOn") : t("isOff")}</p>
      <div>
        <Button variant="outline" disabled={change.isPending} onClick={() => change.mutate(!on)}>
          {on ? t("switchOff") : t("switchOn")}
        </Button>
      </div>
    </section>
  );
}
