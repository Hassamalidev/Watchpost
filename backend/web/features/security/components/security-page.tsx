/*
 * A person's own sign-in security (PRODUCT.md §6.11): two-factor sign-in, and the devices that are
 * signed in to the account, with a way to sign each of them out.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useWorkspace } from "@/components/app/workspace-context";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Loading } from "@/components/ui/skeleton";
import { api, errorMessage, wsPath } from "@/lib/api";
import { sessions, type DeviceSession } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { TwoFactorCard } from "./two-factor-card";

/* "Chrome on Windows" from a user agent, well enough to tell one's own devices apart. */
export function deviceName(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown device";
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : "A browser";
  const system = /Windows/.test(userAgent)
    ? "Windows"
    : /Android/.test(userAgent)
      ? "Android"
      : /iPhone|iPad/.test(userAgent)
        ? "iOS"
        : /Mac OS X/.test(userAgent)
          ? "macOS"
          : /Linux/.test(userAgent)
            ? "Linux"
            : "an unknown system";
  return `${browser} on ${system}`;
}

function Sessions() {
  const t = useTranslations("security.sessions");
  const client = useQueryClient();
  const list = useQuery({ queryKey: ["sessions"], queryFn: sessions.list });
  const refresh = () => client.invalidateQueries({ queryKey: ["sessions"] });
  const revoke = useMutation({ mutationFn: sessions.revoke, onSuccess: refresh });
  const revokeOthers = useMutation({ mutationFn: sessions.revokeOthers, onSuccess: refresh });
  const rows = [...(list.data ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <section className="grid gap-4 rounded-lg border p-4" aria-labelledby="sessions-heading">
      <div className="grid gap-1">
        <h2 id="sessions-heading" className="text-base font-semibold">
          {t("title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
      </div>
      {(revoke.isError || revokeOthers.isError) && (
        <Alert tone="error">{errorMessage(revoke.error ?? revokeOthers.error)}</Alert>
      )}
      {list.isLoading ? (
        <Loading rows={2} />
      ) : list.isError ? (
        <Alert tone="error">{errorMessage(list.error)}</Alert>
      ) : (
        <ul className="grid gap-2">
          {rows.map((session: DeviceSession) => (
            <li
              key={session.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
            >
              <div className="min-w-0">
                <p className="font-medium">{deviceName(session.userAgent)}</p>
                <p className="text-sm text-muted-foreground">
                  {t("lastActive", { when: formatDateTime(session.updatedAt) })}
                  {session.ipAddress ? ` · ${session.ipAddress}` : ""}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={revoke.isPending}
                aria-label={t("signOutNamed", {
                  device: deviceName(session.userAgent),
                  when: formatDateTime(session.updatedAt),
                })}
                onClick={() => revoke.mutate(session.token)}
              >
                {t("signOut")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {rows.length > 1 && (
        <div>
          <Button
            variant="outline"
            disabled={revokeOthers.isPending}
            onClick={() => revokeOthers.mutate()}
          >
            {t("signOutOthers")}
          </Button>
        </div>
      )}
    </section>
  );
}

export function SecurityPage() {
  const t = useTranslations("security");
  const { id: ws } = useWorkspace();
  const client = useQueryClient();
  const me = useQuery({
    queryKey: ["me-security", ws],
    queryFn: () => api<{ twoFactorEnabled: boolean }>(wsPath(ws, "/me")),
  });
  return (
    <div className="grid max-w-3xl gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("intro")}</p>
      </div>
      {me.data === undefined ? (
        <Loading rows={3} />
      ) : (
        <TwoFactorCard
          enabled={me.data.twoFactorEnabled}
          onChanged={() => {
            void client.invalidateQueries({ queryKey: ["me-security", ws] });
            void client.invalidateQueries({ queryKey: ["workspace-gate", ws] });
          }}
        />
      )}
      <Sessions />
    </div>
  );
}
