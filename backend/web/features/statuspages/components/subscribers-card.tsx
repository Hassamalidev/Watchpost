/*
 * Who gets a status page's updates by email. People subscribe themselves on the public page and
 * confirm by email; here the team sees them and can remove one.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { StatusPageView } from "@app/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Loading } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { statusPageKeys, statusPagesApi } from "../api";

export function SubscribersCard({
  ws,
  page,
  canEdit,
}: {
  ws: string;
  page: StatusPageView;
  canEdit: boolean;
}) {
  const t = useTranslations("statusPages.subscribers");
  const client = useQueryClient();
  const key = [...statusPageKeys.one(ws, page.id), "subscribers"] as const;
  const subscribers = useQuery({
    queryKey: key,
    queryFn: () => statusPagesApi.subscribers(ws, page.id),
  });
  const remove = useMutation({
    mutationFn: (id: string) => statusPagesApi.removeSubscriber(ws, page.id, id),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });

  if (subscribers.isLoading) return <Loading rows={2} />;
  if (subscribers.isError || subscribers.data === undefined) {
    return <Alert tone="error">{errorMessage(subscribers.error)}</Alert>;
  }
  const { confirmed, pending, limit, data } = subscribers.data;

  if (limit === 0) return <p className="text-sm text-muted-foreground">{t("notOnPlan")}</p>;
  if (!page.settings.subscribers) {
    return <p className="text-sm text-muted-foreground">{t("switchedOff")}</p>;
  }

  return (
    <div className="grid gap-3 text-sm">
      {remove.isError && <Alert tone="error">{errorMessage(remove.error)}</Alert>}
      <p>
        {t("summary", { confirmed, limit })}
        {pending > 0 && ` ${t("pending", { count: pending })}`}
      </p>
      {data.length === 0 ? (
        <p className="text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {data.map((subscriber) => (
            <li
              key={subscriber.id}
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{subscriber.email}</p>
                <p className="text-xs text-muted-foreground">
                  {subscriber.confirmedAt === null
                    ? t("waiting")
                    : t("since", { time: formatDateTime(subscriber.confirmedAt) })}
                </p>
              </div>
              {canEdit && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={remove.isPending}
                  aria-label={t("removeLabel", { email: subscriber.email })}
                  onClick={() => {
                    if (globalThis.confirm(t("confirmRemove", { email: subscriber.email }))) {
                      remove.mutate(subscriber.id);
                    }
                  }}
                >
                  {t("remove")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
