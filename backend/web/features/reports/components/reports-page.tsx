/*
 * Reports (PRODUCT.md §6.10): an SLA report for every monitor, one monitor, a group or a status
 * page over a period, on screen and as PDF or CSV, and the schedules that email it to people
 * inside or outside the workspace. Every number comes from the API; nothing is worked out here.
 */
"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  REPORT_FREQUENCIES,
  REPORT_MAX_RECIPIENTS,
  REPORT_TARGET_KINDS,
  reportScheduleInputSchema,
  type ReportFrequency,
  type ReportTarget,
  type ReportTargetKind,
  type SlaReport,
  type SlaReportTotals,
} from "@app/shared";
import { can, useWorkspace } from "@/components/app/workspace-context";
import { Alert, EmptyState } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Loading } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api";
import { formatDuration, formatPercent } from "@/lib/format";
import { useMonitorGroups, useMonitors } from "@/features/monitors/hooks";
import { useStatusPages } from "@/features/statuspages/api";
import {
  PERIODS,
  periodRange,
  reportFileHref,
  reportKeys,
  reportsApi,
  useReportSchedules,
  useSlaReport,
  type Period,
  type ReportQuery,
} from "../api";

const seconds = (value: number | null) => (value === null ? "—" : formatDuration(value));
const ms = (value: number | null) => (value === null ? "—" : `${Math.round(value)} ms`);

function Summary({ totals }: { totals: SlaReportTotals }) {
  const t = useTranslations("reports");
  const items = [
    [t("uptime"), formatPercent(totals.uptimePercent)],
    [t("downtime"), formatDuration(totals.downtimeSeconds)],
    [t("incidents"), String(totals.incidents)],
    [t("mtta"), seconds(totals.mttaSeconds)],
    [t("mttr"), seconds(totals.mttrSeconds)],
    [t("p95"), ms(totals.p95)],
  ] as const;
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {items.map(([label, value]) => (
        <div key={label} className="rounded-md border p-3">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="text-lg font-semibold tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ReportTable({ report }: { report: SlaReport }) {
  const t = useTranslations("reports");
  if (report.rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("noMonitors")}</p>;
  }
  const number = "px-2 py-2 text-right tabular-nums";
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{t("tableCaption")}</caption>
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th scope="col" className="px-2 py-2 font-medium">
              {t("monitor")}
            </th>
            {[
              t("uptime"),
              t("downtime"),
              t("incidents"),
              t("mtta"),
              t("mttr"),
              "p50",
              "p95",
              "p99",
            ].map((label) => (
              <th key={label} scope="col" className="px-2 py-2 text-right font-medium">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row) => (
            <tr key={row.monitorId} className="border-b last:border-0">
              <th scope="row" className="max-w-56 truncate px-2 py-2 text-left font-normal">
                {row.name}
              </th>
              <td className={number}>{formatPercent(row.uptimePercent)}</td>
              <td className={number}>{formatDuration(row.downtimeSeconds)}</td>
              <td className={number}>{row.incidents}</td>
              <td className={number}>{seconds(row.mttaSeconds)}</td>
              <td className={number}>{seconds(row.mttrSeconds)}</td>
              <td className={number}>{ms(row.p50)}</td>
              <td className={number}>{ms(row.p95)}</td>
              <td className={number}>{ms(row.p99)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Schedules({
  ws,
  canManage,
  target,
  targetName,
  excludeMaintenance,
}: {
  ws: string;
  canManage: boolean;
  target: ReportTarget | undefined;
  targetName: string;
  excludeMaintenance: boolean;
}) {
  const t = useTranslations("reports");
  const tc = useTranslations("common");
  const client = useQueryClient();
  const schedules = useReportSchedules(ws);
  const [name, setName] = React.useState("");
  const [frequency, setFrequency] = React.useState<ReportFrequency>("monthly");
  const [recipients, setRecipients] = React.useState("");
  const [brandName, setBrandName] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: reportKeys.schedules(ws) });

  const create = useMutation({
    mutationFn: reportsApi.createSchedule.bind(null, ws),
    onSuccess: async () => {
      setName("");
      setRecipients("");
      setBrandName("");
      await refresh();
    },
    onError: (err) => setProblem(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => reportsApi.deleteSchedule(ws, id),
    onSuccess: refresh,
  });

  function submit() {
    setProblem(null);
    if (target === undefined) {
      setProblem(t("chooseTarget"));
      return;
    }
    const parsed = reportScheduleInputSchema.safeParse({
      name: name.trim(),
      target,
      frequency,
      recipients: recipients
        .split(/[\s,;]+/)
        .map((address) => address.trim())
        .filter((address) => address !== ""),
      excludeMaintenance,
      brandName: brandName.trim() === "" ? null : brandName.trim(),
    });
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      setProblem(field === "name" ? t("scheduleNameRequired") : t("recipientsInvalid"));
      return;
    }
    create.mutate(parsed.data);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("schedulesTitle")}</CardTitle>
        <CardDescription>{t("schedulesIntro")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {schedules.isLoading ? (
          <Loading rows={2} />
        ) : schedules.isError ? (
          <Alert tone="error">{errorMessage(schedules.error)}</Alert>
        ) : (schedules.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noSchedules")}</p>
        ) : (
          <ul className="grid gap-2">
            {(schedules.data ?? []).map((schedule) => (
              <li
                key={schedule.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
              >
                <div className="min-w-0">
                  <p className="font-medium">{schedule.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {t(`frequency.${schedule.frequency}`)} · {t(`kind.${schedule.target.kind}`)}
                    {schedule.target.kind === "workspace" ? "" : `: ${schedule.target.name}`} ·{" "}
                    {schedule.recipients.length === 0
                      ? t("noRecipients")
                      : schedule.recipients.join(", ")}
                  </p>
                </div>
                {canManage && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={remove.isPending}
                    aria-label={t("deleteSchedule", { name: schedule.name })}
                    onClick={() => remove.mutate(schedule.id)}
                  >
                    {tc("delete")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {remove.isError && <Alert tone="error">{errorMessage(remove.error)}</Alert>}
        {canManage && (
          <form
            className="grid max-w-xl gap-4 border-t pt-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <p className="text-sm text-muted-foreground">
              {t("scheduleCovers", { target: targetName })}
            </p>
            {problem && <Alert tone="error">{problem}</Alert>}
            <Field label={t("scheduleName")} htmlFor="report-name">
              <Input
                id="report-name"
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label={t("frequencyLabel")} htmlFor="report-frequency">
              <Select
                id="report-frequency"
                value={frequency}
                onChange={(e) => setFrequency(e.target.value as ReportFrequency)}
              >
                {REPORT_FREQUENCIES.map((f) => (
                  <option key={f} value={f}>
                    {t(`frequency.${f}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label={t("recipients")}
              htmlFor="report-recipients"
              hint={t("recipientsHint", { max: REPORT_MAX_RECIPIENTS })}
            >
              <Input
                id="report-recipients"
                value={recipients}
                placeholder="client@example.com, boss@example.com"
                onChange={(e) => setRecipients(e.target.value)}
              />
            </Field>
            <Field label={t("brandName")} htmlFor="report-brand" hint={t("brandHint")}>
              <Input
                id="report-brand"
                value={brandName}
                maxLength={80}
                onChange={(e) => setBrandName(e.target.value)}
              />
            </Field>
            <div>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? tc("saving") : t("addSchedule")}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

export function ReportsPage() {
  const t = useTranslations("reports");
  const { id: ws, role } = useWorkspace();
  const monitors = useMonitors(ws);
  const groups = useMonitorGroups(ws);
  const pages = useStatusPages(ws);
  const [kind, setKind] = React.useState<ReportTargetKind>("workspace");
  const [id, setId] = React.useState("");
  const [period, setPeriod] = React.useState<Period>("last30");
  const [excludeMaintenance, setExcludeMaintenance] = React.useState(true);
  /* One "now" for the page, so the period (and the query behind it) doesn't move while you read. */
  const [now] = React.useState(() => new Date(Math.floor(Date.now() / 60_000) * 60_000));

  const choices: Array<{ id: string; name: string }> =
    kind === "monitor"
      ? (monitors.data ?? [])
      : kind === "group"
        ? (groups.data ?? [])
        : kind === "page"
          ? (pages.data ?? [])
          : [];
  const chosen = choices.find((c) => c.id === id);
  const target: ReportTarget | undefined =
    kind === "workspace" ? { kind } : chosen === undefined ? undefined : { kind, id: chosen.id };
  const query: ReportQuery = {
    target: target ?? { kind: "workspace" },
    ...periodRange(period, now),
    excludeMaintenance,
  };
  const report = useSlaReport(ws, query, target !== undefined);

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("intro")}</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t("slaTitle")}</CardTitle>
          <CardDescription>{t("slaIntro")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t("about")} htmlFor="report-kind">
              <Select
                id="report-kind"
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as ReportTargetKind);
                  setId("");
                }}
              >
                {REPORT_TARGET_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`kind.${k}`)}
                  </option>
                ))}
              </Select>
            </Field>
            {kind !== "workspace" && (
              <Field label={t(`kind.${kind}`)} htmlFor="report-target">
                <Select id="report-target" value={id} onChange={(e) => setId(e.target.value)}>
                  <option value="">{t("choose")}</option>
                  {choices.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label={t("period")} htmlFor="report-period">
              <Select
                id="report-period"
                value={period}
                onChange={(e) => setPeriod(e.target.value as Period)}
              >
                {PERIODS.map((p) => (
                  <option key={p} value={p}>
                    {t(`periods.${p}`)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={excludeMaintenance}
              onChange={(e) => setExcludeMaintenance(e.target.checked)}
            />
            {t("excludeMaintenance")}
          </label>

          {target === undefined ? (
            <EmptyState title={t("chooseTarget")}>{t("chooseTargetBody")}</EmptyState>
          ) : report.isLoading ? (
            <Loading rows={4} />
          ) : report.isError ? (
            <Alert tone="error">{errorMessage(report.error)}</Alert>
          ) : report.data ? (
            <>
              <Summary totals={report.data.totals} />
              <ReportTable report={report.data} />
              {report.data.truncated && <Alert tone="info">{t("truncated")}</Alert>}
              <p className="text-xs text-muted-foreground">{t("method")}</p>
              <div className="flex flex-wrap gap-4">
                <a
                  className="text-sm underline underline-offset-4"
                  href={reportFileHref(ws, "pdf", query)}
                >
                  {t("downloadPdf")}
                </a>
                <a
                  className="text-sm underline underline-offset-4"
                  href={reportFileHref(ws, "csv", query)}
                >
                  {t("downloadCsv")}
                </a>
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>
      <Schedules
        ws={ws}
        canManage={can(role, "settings:update")}
        target={target}
        targetName={kind === "workspace" ? t("kind.workspace") : (chosen?.name ?? t("choose"))}
        excludeMaintenance={excludeMaintenance}
      />
    </div>
  );
}
