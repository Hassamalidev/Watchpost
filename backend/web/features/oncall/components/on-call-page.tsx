/*
 * On-call: every schedule with who is on call right now, a form for admins to add one, and your
 * own calendar feed link.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { CreateScheduleInput, ScheduleSummary, ScheduleView } from "@app/shared";
import { can, useWorkspace } from "@/components/app/workspace-context";
import { Alert, EmptyState } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyField } from "@/components/ui/copy-field";
import { Loading } from "@/components/ui/skeleton";
import { api, errorMessage, wsPath } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { workspaceHref } from "@/lib/navigation";
import { EscalationPolicies } from "./escalation-policies";
import { MyOnCall } from "./my-on-call";
import { ScheduleForm } from "./schedule-form";

export const oncallKeys = {
  list: (ws: string) => ["schedules", ws] as const,
  one: (ws: string, id: string) => ["schedules", ws, id] as const,
  feed: (ws: string) => ["oncall-feed", ws] as const,
};

function FeedCard({ ws }: { ws: string }) {
  const t = useTranslations("oncall.feed");
  const client = useQueryClient();
  const feed = useQuery({
    queryKey: oncallKeys.feed(ws),
    queryFn: () =>
      api<{ exists: boolean; createdAt: string | null }>(wsPath(ws, "/me/oncall-feed")),
  });
  const rotate = useMutation({
    mutationFn: () => api<{ url: string }>(wsPath(ws, "/me/oncall-feed"), { method: "POST" }),
    onSuccess: () => client.invalidateQueries({ queryKey: oncallKeys.feed(ws) }),
  });
  const remove = useMutation({
    mutationFn: () => api(wsPath(ws, "/me/oncall-feed"), { method: "DELETE" }),
    onSuccess: async () => {
      rotate.reset();
      await client.invalidateQueries({ queryKey: oncallKeys.feed(ws) });
    },
  });
  const exists = feed.data?.exists === true;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-sm text-muted-foreground">{t("hint")}</p>
        {rotate.isError && <Alert tone="error">{errorMessage(rotate.error)}</Alert>}
        {rotate.data !== undefined && (
          <div className="grid gap-2">
            <CopyField label={t("url")} value={rotate.data.url} />
            <p className="text-sm text-muted-foreground">{t("shownOnce")}</p>
          </div>
        )}
        {exists && rotate.data === undefined && feed.data?.createdAt && (
          <p className="text-sm">{t("active", { date: formatDateTime(feed.data.createdAt) })}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant={exists ? "outline" : "default"}
            disabled={rotate.isPending}
            onClick={() => rotate.mutate()}
          >
            {exists ? t("replace") : t("create")}
          </Button>
          {exists && (
            <Button
              type="button"
              variant="outline"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {t("turnOff")}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function OnCallPage() {
  const t = useTranslations("oncall");
  const workspace = useWorkspace();
  const ws = workspace.id;
  const client = useQueryClient();
  const canWrite = can(workspace.role, "schedule:write");
  const [adding, setAdding] = React.useState(false);
  const list = useQuery({
    queryKey: oncallKeys.list(ws),
    queryFn: async () => (await api<{ data: ScheduleSummary[] }>(wsPath(ws, "/schedules"))).data,
    refetchInterval: 60_000,
  });
  const create = useMutation({
    mutationFn: (body: CreateScheduleInput) =>
      api<ScheduleView>(wsPath(ws, "/schedules"), { method: "POST", body }),
    onSuccess: async () => {
      setAdding(false);
      await client.invalidateQueries({ queryKey: oncallKeys.list(ws) });
      await client.invalidateQueries({ queryKey: ["my-on-call", ws] });
    },
  });

  return (
    <div className="grid max-w-4xl gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="grid flex-1 gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("lead")}</p>
        </div>
        {canWrite && !adding && (
          <Button type="button" onClick={() => setAdding(true)}>
            {t("new")}
          </Button>
        )}
      </div>

      {can(workspace.role, "contact:manage") && <MyOnCall ws={ws} />}

      {adding && (
        <Card>
          <CardHeader>
            <CardTitle>{t("new")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ScheduleForm
              ws={ws}
              submitLabel={t("create")}
              pending={create.isPending}
              error={create.isError ? errorMessage(create.error) : undefined}
              onSubmit={(body) => create.mutate(body)}
            />
            <div className="mt-3">
              <Button type="button" variant="outline" onClick={() => setAdding(false)}>
                {t("cancel")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <section className="grid gap-2" aria-labelledby="schedules-heading">
        <h2 id="schedules-heading" className="text-base font-semibold">
          {t("schedules")}
        </h2>
        {list.isError && <Alert tone="error">{errorMessage(list.error)}</Alert>}
        {list.isPending ? (
          <Loading rows={2} />
        ) : (list.data ?? []).length === 0 ? (
          <EmptyState title={t("empty")}>
            <p>{canWrite ? t("emptyHintAdmin") : t("emptyHint")}</p>
            {canWrite && (
              <p>
                <Link
                  href={`${workspaceHref(ws, "settings")}/import?source=opsgenie`}
                  className="text-brand underline"
                >
                  {t("importFromOpsgenie")}
                </Link>
              </p>
            )}
          </EmptyState>
        ) : (
          <ul className="divide-y rounded-lg border">
            {(list.data ?? []).map((schedule) => (
              <li key={schedule.id} className="flex flex-wrap items-center gap-3 px-3 py-3">
                <div className="min-w-0 flex-1">
                  <Link
                    href={`${workspaceHref(ws, "on-call")}/${schedule.id}`}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {schedule.name}
                  </Link>
                  <p className="text-xs text-muted-foreground">{schedule.timezone}</p>
                </div>
                <p className="text-sm">
                  {schedule.onCall === null
                    ? t("nobody")
                    : t("onCallNow", { name: schedule.onCall.name ?? t("formerMember") })}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <EscalationPolicies schedules={list.data ?? []} />

      {can(workspace.role, "contact:manage") && <FeedCard ws={ws} />}
    </div>
  );
}
