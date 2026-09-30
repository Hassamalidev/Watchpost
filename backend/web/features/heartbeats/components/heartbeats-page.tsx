/*
 * Heartbeats: cron jobs and workers that ping us. Lists each heartbeat with its state, creates new
 * ones (period + grace) and hands out the ping URL, which is shown only once.
 */
"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Copy } from "lucide-react";
import type { MonitorStatus } from "@app/shared";
import { StatusBadge } from "@/components/app/status-badge";
import { can, useWorkspace } from "@/components/app/workspace-context";
import { Alert, EmptyState } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { api, errorMessage, wsPath } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useCreateMonitor, useMonitors } from "@/features/monitors/hooks";

interface HeartbeatState {
  monitorId: string;
  status: MonitorStatus;
  lastPingAt: string | null;
  nextExpectedAt: string | null;
}

const PERIODS = [60, 300, 900, 3_600, 86_400];

function PingUrl({ ws, monitorId }: { ws: string; monitorId: string }) {
  const t = useTranslations("heartbeats");
  const tc = useTranslations("common");
  const client = useQueryClient();
  const [url, setUrl] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const rotate = useMutation({
    mutationFn: () =>
      api<{ url: string }>(wsPath(ws, `/heartbeats/${monitorId}/token`), {
        method: "POST",
        body: {},
      }),
    onSuccess: (data) => {
      setUrl(data.url);
      return client.invalidateQueries({ queryKey: ["heartbeats", ws] });
    },
  });
  if (url === null) {
    return (
      <Button
        size="sm"
        variant="outline"
        disabled={rotate.isPending}
        onClick={() => rotate.mutate()}
      >
        {t("showUrl")}
      </Button>
    );
  }
  return (
    <div className="grid w-full gap-1">
      <div className="flex gap-2">
        <Input readOnly value={url} aria-label={t("pingUrl")} className="font-mono text-xs" />
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            await navigator.clipboard.writeText(url);
            setCopied(true);
          }}
        >
          <Copy aria-hidden />
          {copied ? tc("copied") : tc("copy")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("urlOnce")}</p>
      <code className="text-xs">{t("usage", { url })}</code>
    </div>
  );
}

export function HeartbeatsPage() {
  const t = useTranslations("heartbeats");
  const tm = useTranslations("monitors");
  const tApp = useTranslations("app");
  const workspace = useWorkspace();
  const ws = workspace.id;
  const monitors = useMonitors(ws);
  const states = useQuery({
    queryKey: ["heartbeats", ws],
    queryFn: async () =>
      new Map(
        (await api<{ data: HeartbeatState[] }>(wsPath(ws, "/heartbeats"))).data.map((s) => [
          s.monitorId,
          s,
        ]),
      ),
    refetchInterval: 10_000,
  });
  const create = useCreateMonitor(ws);
  const [name, setName] = React.useState("");
  const [period, setPeriod] = React.useState("3600");
  const [grace, setGrace] = React.useState("300");
  const [error, setError] = React.useState<string | null>(null);
  const heartbeats = (monitors.data ?? []).filter((m) => m.type === "heartbeat");
  const canEdit = can(workspace.role, "member");

  return (
    <div className="grid max-w-4xl gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-1 text-muted-foreground">{t("intro")}</p>
      </div>
      {monitors.isPending ? (
        <p className="text-muted-foreground">{tApp("loading")}</p>
      ) : heartbeats.length === 0 ? (
        <EmptyState title={t("empty")} />
      ) : (
        <ul className="divide-y rounded-lg border">
          {heartbeats.map((hb) => {
            const state = states.data?.get(hb.id);
            return (
              <li key={hb.id} className="grid gap-2 px-3 py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <StatusBadge status={hb.paused ? "paused" : (state?.status ?? "pending")} />
                  <span className="font-medium">{hb.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {t("lastPing")}: {relativeTime(state?.lastPingAt)} · {t("nextExpected")}:{" "}
                    {relativeTime(state?.nextExpectedAt)}
                  </span>
                </div>
                {canEdit && <PingUrl ws={ws} monitorId={hb.id} />}
              </li>
            );
          })}
        </ul>
      )}
      {canEdit && (
        <Card>
          <CardHeader>
            <CardTitle>{t("new")}</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid max-w-xl gap-3"
              onSubmit={async (e) => {
                e.preventDefault();
                setError(null);
                try {
                  await create.mutateAsync({
                    settings: { name: name.trim() },
                    config: {
                      type: "heartbeat",
                      schedule: { kind: "period", periodSeconds: Number(period) },
                      graceSeconds: Number(grace),
                    },
                  });
                  setName("");
                } catch (err) {
                  setError(errorMessage(err));
                }
              }}
            >
              {error && <Alert tone="error">{error}</Alert>}
              <Field label={tm("name")} htmlFor="hb-name">
                <Input
                  id="hb-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </Field>
              <Field label={t("period")} htmlFor="hb-period">
                <Select id="hb-period" value={period} onChange={(e) => setPeriod(e.target.value)}>
                  {PERIODS.map((s) => (
                    <option key={s} value={s}>
                      {s < 3_600
                        ? tm("minutes", { count: s / 60 })
                        : tm("hours", { count: s / 3_600 })}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("grace")} htmlFor="hb-grace">
                <Select id="hb-grace" value={grace} onChange={(e) => setGrace(e.target.value)}>
                  {[60, 300, 900, 3_600].map((s) => (
                    <option key={s} value={s}>
                      {s < 3_600
                        ? tm("minutes", { count: s / 60 })
                        : tm("hours", { count: s / 3_600 })}
                    </option>
                  ))}
                </Select>
              </Field>
              <div>
                <Button type="submit" disabled={create.isPending}>
                  {t("create")}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
