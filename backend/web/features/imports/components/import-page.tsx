/*
 * Import from another tool: paste its export (or, for UptimeRobot, a read-only API key), preview
 * what each object would become and what can't come over, then import.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  IMPORT_SOURCES,
  IMPORT_SOURCE_LABELS,
  type ImportItemView,
  type ImportPlanView,
  type ImportRunView,
  type ImportSource,
} from "@app/shared";
import { can, useWorkspace } from "@/components/app/workspace-context";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { api, errorMessage, wsPath } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { workspaceHref } from "@/lib/navigation";

function Items({ items }: { items: ImportItemView[] }) {
  const t = useTranslations("imports");
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">{t("itemsCaption")}</caption>
      <thead>
        <tr className="border-b text-left">
          <th scope="col" className="py-1.5 pr-3 font-medium">
            {t("item")}
          </th>
          <th scope="col" className="py-1.5 font-medium">
            {t("outcome")}
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((item, index) => (
          <tr key={index} className="border-b align-top last:border-b-0">
            <th scope="row" className="py-1.5 pr-3 text-left font-normal">
              {item.name}
              <span className="block text-xs text-muted-foreground">{t(`kinds.${item.kind}`)}</span>
            </th>
            <td className="py-1.5">
              {item.action === "skip" ? (
                <span>
                  <span className="font-medium">{t("skipped")}</span> {item.reason}
                </span>
              ) : item.result === "failed" ? (
                <span>
                  <span className="font-medium">{t("failed")}</span> {item.error}
                </span>
              ) : (
                <span>
                  {item.result === "created" && (
                    <span className="font-medium">{t("created")} </span>
                  )}
                  {item.becomes}
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ImportPage() {
  const t = useTranslations("imports");
  const workspace = useWorkspace();
  const ws = workspace.id;
  const client = useQueryClient();
  const allowed = can(workspace.role, "settings:update");
  const [source, setSource] = React.useState<ImportSource>("uptimerobot");
  const [text, setText] = React.useState("");
  const [apiKey, setApiKey] = React.useState("");
  const [problem, setProblem] = React.useState<string | undefined>();
  const history = useQuery({
    queryKey: ["imports", ws],
    enabled: allowed,
    queryFn: async () => (await api<{ data: ImportRunView[] }>(wsPath(ws, "/imports"))).data,
  });

  /* The request for what is in the form, or undefined (with the reason shown) when it isn't ready. */
  function body(): { source: ImportSource; data?: unknown; apiKey?: string } | undefined {
    if (source === "uptimerobot" && apiKey.trim() !== "" && text.trim() === "") {
      setProblem(undefined);
      return { source, apiKey: apiKey.trim() };
    }
    if (text.trim() === "") {
      setProblem(source === "uptimerobot" ? t("needExportOrKey") : t("needExport"));
      return undefined;
    }
    try {
      const data: unknown = JSON.parse(text);
      setProblem(undefined);
      return { source, data };
    } catch {
      setProblem(t("notJson"));
      return undefined;
    }
  }

  const preview = useMutation({
    mutationFn: (request: object) =>
      api<ImportPlanView>(wsPath(ws, "/imports/dry-run"), { method: "POST", body: request }),
  });
  const apply = useMutation({
    mutationFn: (request: object) =>
      api<ImportRunView>(wsPath(ws, "/imports"), { method: "POST", body: request }),
    onSuccess: async () => {
      preview.reset();
      await client.invalidateQueries({ queryKey: ["imports", ws] });
      await client.invalidateQueries({ queryKey: ["monitors", ws] });
    },
  });
  const reset = () => {
    preview.reset();
    apply.reset();
    setProblem(undefined);
  };
  const failure = preview.isError ? preview.error : apply.isError ? apply.error : undefined;

  if (!allowed) {
    return (
      <div className="grid max-w-xl gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <Alert tone="info">{t("adminsOnly")}</Alert>
      </div>
    );
  }

  return (
    <div className="grid max-w-4xl gap-6">
      <div className="grid gap-1">
        <Link href={workspaceHref(ws, "settings")} className="text-sm text-brand underline">
          {t("back")}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("lead")}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("step1")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              apply.reset();
              const request = body();
              if (request !== undefined) preview.mutate(request);
            }}
          >
            <Field label={t("source")} htmlFor="import-source" className="max-w-xs">
              <Select
                id="import-source"
                value={source}
                onChange={(e) => {
                  setSource(e.target.value as ImportSource);
                  reset();
                }}
              >
                {IMPORT_SOURCES.map((option) => (
                  <option key={option} value={option}>
                    {IMPORT_SOURCE_LABELS[option]}
                  </option>
                ))}
              </Select>
            </Field>
            <p className="text-sm">{t(`how.${source}`)}</p>
            {source === "uptimerobot" && (
              <Field
                label={t("apiKey")}
                htmlFor="import-key"
                hint={t("apiKeyHint")}
                className="max-w-md"
              >
                <Input
                  id="import-key"
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </Field>
            )}
            <Field
              label={source === "uptimerobot" ? t("exportOr") : t("export")}
              htmlFor="import-data"
              hint={t("exportHint")}
            >
              <Textarea
                id="import-data"
                rows={8}
                className="font-mono text-xs"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </Field>
            {(problem ?? (failure ? errorMessage(failure) : undefined)) !== undefined && (
              <Alert tone="error">{problem ?? errorMessage(failure)}</Alert>
            )}
            <div>
              <Button type="submit" disabled={preview.isPending}>
                {t("preview")}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {preview.data !== undefined && (
        <Card>
          <CardHeader>
            <CardTitle>{t("step2")}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <p className="text-sm font-medium">
              {t("coverage", {
                mapped: preview.data.mapped,
                total: preview.data.total,
                percent: preview.data.coveragePercent,
              })}
            </p>
            <Items items={preview.data.items} />
            <div>
              <Button
                type="button"
                disabled={apply.isPending || preview.data.mapped === 0}
                onClick={() => {
                  const request = body();
                  if (request !== undefined) apply.mutate(request);
                }}
              >
                {t("apply", { count: preview.data.mapped })}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {apply.data !== undefined && (
        <Card>
          <CardHeader>
            <CardTitle>{t("done")}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Alert tone={apply.data.failed === 0 ? "success" : "info"}>
              {t("result", { created: apply.data.created, failed: apply.data.failed })}
            </Alert>
            <Items items={apply.data.items} />
          </CardContent>
        </Card>
      )}

      <section className="grid gap-2" aria-labelledby="import-history">
        <h2 id="import-history" className="text-base font-semibold">
          {t("history")}
        </h2>
        {(history.data ?? []).length === 0 ? (
          <p className="text-sm">{t("noHistory")}</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {(history.data ?? []).map((run) => (
              <li key={run.id} className="px-3 py-2 text-sm">
                <span className="font-medium">{IMPORT_SOURCE_LABELS[run.source]}</span>
                {" · "}
                {t("historyLine", { created: run.created, total: run.total })}
                <span className="text-muted-foreground"> · {formatDateTime(run.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
