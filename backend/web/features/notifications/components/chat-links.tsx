/*
 * Chat accounts linked to you. A link from Slack (`/watchpost link`, or the note after pressing a
 * button on an alert) opens this page with a token; confirming ties that Slack user to your
 * account, so what they do in Slack is recorded under your name and with your role.
 */
"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, errorMessage, wsPath } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

interface ChatLink {
  id: string;
  provider: "slack" | "telegram";
  externalName: string | null;
  linkedAt: string;
}

export function ChatLinksCard({ ws }: { ws: string }) {
  const t = useTranslations("notifications.chat");
  const client = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const token = useSearchParams().get("link");
  const key = ["chat-links", ws] as const;
  const links = useQuery({
    queryKey: key,
    queryFn: async () => (await api<{ data: ChatLink[] }>(wsPath(ws, "/me/chat-links"))).data,
  });
  const preview = useQuery({
    queryKey: [...key, "preview", token],
    enabled: token !== null,
    queryFn: async () =>
      (
        await api<{ data: { provider: ChatLink["provider"]; externalName: string | null } | null }>(
          wsPath(ws, `/me/chat-links/preview?token=${encodeURIComponent(token ?? "")}`),
        )
      ).data,
  });
  const claim = useMutation({
    mutationFn: () =>
      api(wsPath(ws, "/me/chat-links"), { method: "POST", body: { token: token ?? "" } }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: key });
      /* The token is used; drop it from the address. */
      router.replace(pathname);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(wsPath(ws, `/me/chat-links/${id}`), { method: "DELETE" }),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });
  const list = links.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-sm text-muted-foreground">{t("hint")}</p>
        {links.isError && <Alert tone="error">{errorMessage(links.error)}</Alert>}
        {claim.isError && <Alert tone="error">{errorMessage(claim.error)}</Alert>}
        {remove.isError && <Alert tone="error">{errorMessage(remove.error)}</Alert>}
        {token !== null && preview.isSuccess && preview.data === null && (
          <Alert tone="error">{t("expired")}</Alert>
        )}
        {token !== null && preview.data && (
          <div className="grid gap-2 rounded-lg border p-3">
            <p className="text-sm font-medium">
              {t("confirm", {
                provider: t(`providers.${preview.data.provider}`),
                name: preview.data.externalName ?? t("unnamed"),
              })}
            </p>
            <p className="text-sm text-muted-foreground">{t("confirmHint")}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={claim.isPending} onClick={() => claim.mutate()}>
                {t("link")}
              </Button>
              <Button type="button" variant="outline" onClick={() => router.replace(pathname)}>
                {t("notMe")}
              </Button>
            </div>
          </div>
        )}
        {list.length === 0 ? (
          <p className="text-sm">{t("empty")}</p>
        ) : (
          <ul className="divide-y rounded-lg border" aria-label={t("title")}>
            {list.map((link) => (
              <li key={link.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                <span className="flex-1">
                  <span className="font-medium">{t(`providers.${link.provider}`)}</span>
                  {": "}
                  {link.externalName ?? t("unnamed")}
                  <span className="text-muted-foreground">
                    {" · "}
                    {t("since", { date: formatDateTime(link.linkedAt) })}
                  </span>
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(link.id)}
                >
                  {t("unlink")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
