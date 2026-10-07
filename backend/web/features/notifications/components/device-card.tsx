/*
 * Notifications on this device: asks the browser for permission, subscribes it to web push with the
 * server's key, and saves the subscription as one of your contact methods. On a phone this works
 * best with UptimeWatch added to the home screen (on iPhone and iPad it only works that way).
 */
"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { ContactMethodView } from "@app/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, errorMessage, wsPath } from "@/lib/api";

/* The VAPID key as the bytes `pushManager.subscribe` wants. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/* "Chrome on Android", from what the browser says about itself. */
export function deviceName(userAgent: string): string {
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : "Browser";
  const system = /Android/.test(userAgent)
    ? "Android"
    : /iPhone|iPad|iPod/.test(userAgent)
      ? "iOS"
      : /Windows/.test(userAgent)
        ? "Windows"
        : /Mac OS X/.test(userAgent)
          ? "macOS"
          : /Linux/.test(userAgent)
            ? "Linux"
            : "this device";
  return `${browser} on ${system}`;
}

type Support = "checking" | "unsupported" | "ready";

export function DeviceCard({ ws, methods }: { ws: string; methods: ContactMethodView[] }) {
  const t = useTranslations("notifications.device");
  const client = useQueryClient();
  const [support, setSupport] = React.useState<Support>("checking");
  const [endpoint, setEndpoint] = React.useState<string | null>(null);
  const [denied, setDenied] = React.useState(false);
  const config = useQuery({
    queryKey: ["push-config", ws],
    queryFn: () => api<{ available: boolean; publicKey: string | null }>(wsPath(ws, "/me/push")),
  });

  /* What this browser can do, and whether it is subscribed already. */
  React.useEffect(() => {
    let cancelled = false;
    async function look() {
      if (
        typeof window === "undefined" ||
        !("serviceWorker" in navigator) ||
        !("PushManager" in window) ||
        !("Notification" in window)
      ) {
        setSupport("unsupported");
        return;
      }
      setDenied(Notification.permission === "denied");
      const registration = await navigator.serviceWorker.getRegistration("/");
      const existing = (await registration?.pushManager.getSubscription()) ?? null;
      if (!cancelled) {
        setEndpoint(existing?.endpoint ?? null);
        setSupport("ready");
      }
    }
    void look().catch(() => {
      if (!cancelled) setSupport("unsupported");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ["contact-methods", ws] });
    await client.invalidateQueries({ queryKey: ["notification-rules", ws] });
  };
  const enable = useMutation({
    mutationFn: async () => {
      const publicKey = config.data?.publicKey;
      if (!publicKey) throw new Error(t("notConfigured"));
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setDenied(permission === "denied");
        throw new Error(t("denied"));
      }
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(publicKey),
      });
      const json = subscription.toJSON();
      await api(wsPath(ws, "/me/contact-methods"), {
        method: "POST",
        body: {
          type: "push",
          address: subscription.endpoint,
          label: deviceName(navigator.userAgent),
          push: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
        },
      });
      setEndpoint(subscription.endpoint);
    },
    onSuccess: refresh,
  });
  const mine = endpoint === null ? undefined : methods.find((m) => m.address === endpoint);
  const disable = useMutation({
    mutationFn: async () => {
      const registration = await navigator.serviceWorker.getRegistration("/");
      await (await registration?.pushManager.getSubscription())?.unsubscribe();
      if (mine !== undefined) {
        await api(wsPath(ws, `/me/contact-methods/${mine.id}`), { method: "DELETE" });
      }
      setEndpoint(null);
    },
    onSuccess: refresh,
  });

  const available = config.data?.available === true;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-sm text-muted-foreground">{t("hint")}</p>
        {enable.isError && <Alert tone="error">{errorMessage(enable.error)}</Alert>}
        {disable.isError && <Alert tone="error">{errorMessage(disable.error)}</Alert>}
        {support === "unsupported" ? (
          <Alert tone="info">{t("unsupported")}</Alert>
        ) : config.isSuccess && !available ? (
          <Alert tone="info">{t("notConfigured")}</Alert>
        ) : denied ? (
          <Alert tone="info">{t("denied")}</Alert>
        ) : mine !== undefined ? (
          <>
            <p className="text-sm font-medium">
              {t("on", { name: mine.label ?? t("thisDevice") })}
            </p>
            <div>
              <Button
                type="button"
                variant="outline"
                disabled={disable.isPending}
                onClick={() => disable.mutate()}
              >
                {t("turnOff")}
              </Button>
            </div>
          </>
        ) : (
          <div>
            <Button
              type="button"
              disabled={support !== "ready" || !available || enable.isPending}
              onClick={() => enable.mutate()}
            >
              {t("turnOn")}
            </Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{t("install")}</p>
      </CardContent>
    </Card>
  );
}
