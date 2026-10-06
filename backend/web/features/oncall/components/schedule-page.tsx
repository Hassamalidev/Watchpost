/*
 * One schedule: who is on call now and next, a two-week calendar in the schedule's time zone,
 * overrides ("cover for me"), and editing for admins.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type {
  CreateScheduleInput,
  OnCallNow,
  OnCallSegment,
  ScheduleOverrideView,
  ScheduleView,
} from "@app/shared";
import { can, useWorkspace } from "@/components/app/workspace-context";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Loading } from "@/components/ui/skeleton";
import { ApiError, api, errorMessage, wsPath } from "@/lib/api";
import { workspaceHref } from "@/lib/navigation";
import { calendarDays, calendarRange, isoToLocalInput, localInputToIso } from "../calendar";
import { oncallKeys } from "./on-call-page";
import { ScheduleForm, formOf } from "./schedule-form";

const CALENDAR_DAYS = 14;
const DAY_MS = 86_400_000;

function inZone(ms: number | string, timeZone: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("en", { timeZone, ...options }).format(new Date(ms));
}
const timeIn = (ms: number | string, timeZone: string) =>
  inZone(ms, timeZone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dateTimeIn = (ms: number | string, timeZone: string) =>
  inZone(ms, timeZone, { dateStyle: "medium", timeStyle: "short" });

function NowCard({ ws, schedule }: { ws: string; schedule: ScheduleView }) {
  const t = useTranslations("oncall");
  const now = useQuery({
    queryKey: [...oncallKeys.one(ws, schedule.id), "now"],
    queryFn: () => api<OnCallNow>(wsPath(ws, `/schedules/${schedule.id}/on-call`)),
    refetchInterval: 60_000,
  });
  const name = (segment: OnCallSegment | null) =>
    segment?.user === null || segment?.user === undefined
      ? t("nobodyShort")
      : (segment.user.name ?? t("formerMember"));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("nowTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        {now.isPending ? (
          <Loading rows={1} />
        ) : now.isError ? (
          <Alert tone="error">{errorMessage(now.error)}</Alert>
        ) : (
          <>
            <p className="text-lg font-semibold">{name(now.data.current)}</p>
            {now.data.current !== null && (
              <p className="text-sm text-muted-foreground">
                {now.data.current.source === "override"
                  ? t("untilOverride", {
                      time: dateTimeIn(now.data.current.endsAt, schedule.timezone),
                    })
                  : t("until", { time: dateTimeIn(now.data.current.endsAt, schedule.timezone) })}
              </p>
            )}
            {now.data.next !== null && (
              <p className="text-sm">
                {t("next", {
                  name: name(now.data.next),
                  time: dateTimeIn(now.data.next.startsAt, schedule.timezone),
                })}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function CalendarCard({ ws, schedule }: { ws: string; schedule: ScheduleView }) {
  const t = useTranslations("oncall");
  /* The first day shown; moves two weeks at a time. */
  const [anchor, setAnchor] = React.useState(() => Date.now());
  const range = calendarRange(schedule.timezone, anchor, CALENDAR_DAYS);
  const timeline = useQuery({
    queryKey: [...oncallKeys.one(ws, schedule.id), "timeline", range.from, range.to],
    queryFn: async () =>
      (
        await api<{ data: OnCallSegment[] }>(
          wsPath(
            ws,
            `/schedules/${schedule.id}/timeline?from=${encodeURIComponent(new Date(range.from).toISOString())}&to=${encodeURIComponent(new Date(range.to).toISOString())}`,
          ),
        )
      ).data,
  });
  const days = calendarDays(timeline.data ?? [], schedule.timezone, range.from, CALENDAR_DAYS);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("calendar")}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setAnchor(range.from - CALENDAR_DAYS * DAY_MS + DAY_MS / 2)}
          >
            {t("earlier")}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setAnchor(Date.now())}>
            {t("today")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setAnchor(range.to + DAY_MS / 2)}
          >
            {t("later")}
          </Button>
          <p className="text-sm text-muted-foreground">
            {t("timesIn", { timezone: schedule.timezone })}
          </p>
        </div>
        {timeline.isError && <Alert tone="error">{errorMessage(timeline.error)}</Alert>}
        {timeline.isPending ? (
          <Loading rows={4} />
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">{t("calendarCaption", { name: schedule.name })}</caption>
            <thead>
              <tr className="border-b text-left">
                <th scope="col" className="py-1.5 pr-3 font-medium">
                  {t("day")}
                </th>
                <th scope="col" className="py-1.5 font-medium">
                  {t("whoOnCall")}
                </th>
              </tr>
            </thead>
            <tbody>
              {days.map((day) => (
                <tr key={day.date} className="border-b align-top last:border-b-0">
                  <th scope="row" className="py-1.5 pr-3 text-left font-normal whitespace-nowrap">
                    {inZone(day.startsAt, schedule.timezone, {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                    })}
                  </th>
                  <td className="py-1.5">
                    <ul className="grid gap-0.5">
                      {day.blocks.map((block) => (
                        <li key={block.startsAt}>
                          {day.blocks.length > 1 && (
                            <span className="text-muted-foreground">
                              {timeIn(block.startsAt, schedule.timezone)}–
                              {timeIn(block.endsAt, schedule.timezone)}{" "}
                            </span>
                          )}
                          <span className={block.userId === null ? "text-muted-foreground" : ""}>
                            {block.userId === null
                              ? t("nobodyShort")
                              : (block.name ?? t("formerMember"))}
                          </span>
                          {block.source === "override" && (
                            <span className="text-muted-foreground"> ({t("override")})</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

function OverridesCard({ ws, schedule }: { ws: string; schedule: ScheduleView }) {
  const t = useTranslations("oncall");
  const workspace = useWorkspace();
  const client = useQueryClient();
  const canOverride = can(workspace.role, "schedule:override");
  /* People already on the schedule, and yourself. */
  const people = React.useMemo(() => {
    const seen = new Map<string, string>();
    seen.set(workspace.user.id, workspace.user.name || workspace.user.email);
    for (const layer of schedule.layers) {
      for (const p of layer.participants) {
        if (!seen.has(p.userId) && p.name !== null) seen.set(p.userId, p.name);
      }
    }
    return [...seen.entries()];
  }, [schedule.layers, workspace.user]);
  const [userId, setUserId] = React.useState(workspace.user.id);
  const [start, setStart] = React.useState(() => isoToLocalInput(new Date().toISOString()));
  const [end, setEnd] = React.useState(() =>
    isoToLocalInput(new Date(Date.now() + 8 * 3_600_000).toISOString()),
  );
  const [problem, setProblem] = React.useState<string | undefined>();
  const refresh = () => client.invalidateQueries({ queryKey: oncallKeys.one(ws, schedule.id) });
  const add = useMutation({
    mutationFn: (body: { userId: string; startsAt: string; endsAt: string }) =>
      api<ScheduleOverrideView>(wsPath(ws, `/schedules/${schedule.id}/overrides`), {
        method: "POST",
        body,
      }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(wsPath(ws, `/schedules/${schedule.id}/overrides/${id}`), { method: "DELETE" }),
    onSuccess: refresh,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("overrides")}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-sm text-muted-foreground">{t("overridesHint")}</p>
        {remove.isError && <Alert tone="error">{errorMessage(remove.error)}</Alert>}
        {schedule.overrides.length === 0 ? (
          <p className="text-sm">{t("noOverrides")}</p>
        ) : (
          <ul className="divide-y rounded-lg border" aria-label={t("overrides")}>
            {schedule.overrides.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                <span className="flex-1">
                  <span className="font-medium">{o.user.name ?? t("formerMember")}</span>
                  {": "}
                  {dateTimeIn(o.startsAt, schedule.timezone)} –{" "}
                  {dateTimeIn(o.endsAt, schedule.timezone)}
                </span>
                {canOverride && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(o.id)}
                  >
                    {t("removeOverride")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canOverride && (
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              const startsAt = localInputToIso(start);
              const endsAt = localInputToIso(end);
              if (startsAt === undefined || endsAt === undefined || endsAt <= startsAt) {
                setProblem(t("overrideTimes"));
                return;
              }
              setProblem(undefined);
              add.mutate({ userId, startsAt, endsAt });
            }}
          >
            <h3 className="text-sm font-semibold">{t("addOverride")}</h3>
            {(problem ?? (add.isError ? errorMessage(add.error) : undefined)) !== undefined && (
              <Alert tone="error">{problem ?? errorMessage(add.error)}</Alert>
            )}
            {add.isSuccess && <Alert tone="success">{t("overrideAdded")}</Alert>}
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={t("overrideWho")} htmlFor="override-user">
                <Select
                  id="override-user"
                  value={userId}
                  onChange={(e) => setUserId(e.target.value)}
                >
                  {people.map(([id, name]) => (
                    <option key={id} value={id}>
                      {id === workspace.user.id ? t("me", { name }) : name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("overrideFrom")} htmlFor="override-start" hint={t("yourTime")}>
                <Input
                  id="override-start"
                  type="datetime-local"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                />
              </Field>
              <Field label={t("overrideTo")} htmlFor="override-end">
                <Input
                  id="override-end"
                  type="datetime-local"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                />
              </Field>
            </div>
            <div>
              <Button type="submit" disabled={add.isPending}>
                {t("addOverrideButton")}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

export function SchedulePage({ scheduleId }: { scheduleId: string }) {
  const t = useTranslations("oncall");
  const workspace = useWorkspace();
  const ws = workspace.id;
  const router = useRouter();
  const client = useQueryClient();
  const canWrite = can(workspace.role, "schedule:write");
  const [editing, setEditing] = React.useState(false);
  const schedule = useQuery({
    queryKey: oncallKeys.one(ws, scheduleId),
    queryFn: () => api<ScheduleView>(wsPath(ws, `/schedules/${scheduleId}`)),
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });
  const save = useMutation({
    mutationFn: (body: CreateScheduleInput) =>
      api<ScheduleView>(wsPath(ws, `/schedules/${scheduleId}`), { method: "PATCH", body }),
    onSuccess: async () => {
      setEditing(false);
      await client.invalidateQueries({ queryKey: ["schedules", ws] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api(wsPath(ws, `/schedules/${scheduleId}`), { method: "DELETE" }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: oncallKeys.list(ws) });
      router.push(workspaceHref(ws, "on-call"));
    },
  });
  const back = (
    <Link href={workspaceHref(ws, "on-call")} className="text-sm text-brand underline">
      {t("back")}
    </Link>
  );

  if (schedule.isPending) return <Loading rows={4} />;
  if (schedule.isError) {
    return (
      <div className="grid max-w-xl gap-3">
        <Alert tone="error">
          {schedule.error instanceof ApiError && schedule.error.status === 404
            ? t("notFound")
            : errorMessage(schedule.error)}
        </Alert>
        {back}
      </div>
    );
  }
  const data = schedule.data;

  return (
    <div className="grid max-w-4xl gap-6">
      <div className="grid gap-1">
        {back}
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="flex-1 text-2xl font-semibold tracking-tight">{data.name}</h1>
          {canWrite && !editing && (
            <>
              <Button type="button" variant="outline" onClick={() => setEditing(true)}>
                {t("edit")}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={remove.isPending}
                onClick={() => {
                  if (window.confirm(t("deleteConfirm", { name: data.name }))) remove.mutate();
                }}
              >
                {t("delete")}
              </Button>
            </>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {t("summary", { timezone: data.timezone, layers: data.layers.length })}
        </p>
      </div>
      {remove.isError && <Alert tone="error">{errorMessage(remove.error)}</Alert>}

      {editing ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("edit")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ScheduleForm
              ws={ws}
              initial={formOf(data)}
              submitLabel={t("save")}
              pending={save.isPending}
              error={save.isError ? errorMessage(save.error) : undefined}
              onSubmit={(body) => save.mutate(body)}
            />
            <div className="mt-3">
              <Button type="button" variant="outline" onClick={() => setEditing(false)}>
                {t("cancel")}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          <NowCard ws={ws} schedule={data} />
          <CalendarCard ws={ws} schedule={data} />
          <OverridesCard ws={ws} schedule={data} />
        </>
      )}
    </div>
  );
}
