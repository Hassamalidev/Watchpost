/*
 * The audit log (PRODUCT.md §6.11): who changed what in the workspace, newest first, with a filter
 * by kind and a CSV export. On plans without the full log it shows security events and says so.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { AUDIT_CATEGORIES, type AuditCategory, type AuditLogPage } from "@app/shared";
import { can, useWorkspace } from "@/components/app/workspace-context";
import { Alert, EmptyState } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/input";
import { Loading } from "@/components/ui/skeleton";
import { api, errorMessage, wsPath } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { workspaceHref } from "@/lib/navigation";

export function AuditLog() {
  const t = useTranslations("settings.audit");
  const { id: ws, role } = useWorkspace();
  const [category, setCategory] = React.useState<AuditCategory | "">("");
  const allowed = can(role, "settings:update");
  const log = useInfiniteQuery({
    queryKey: ["audit-log", ws, category],
    enabled: allowed,
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: "50" });
      if (pageParam !== "") params.set("cursor", pageParam);
      if (category !== "") params.set("category", category);
      return api<AuditLogPage>(wsPath(ws, `/audit-log?${params.toString()}`));
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const entries = (log.data?.pages ?? []).flatMap((page) => page.data);
  const securityOnly = log.data?.pages[0]?.securityOnly === true;

  return (
    <div className="grid max-w-5xl gap-6">
      <div>
        <Link href={workspaceHref(ws, "settings")} className="text-sm underline">
          {t("back")}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("intro")}</p>
      </div>
      {!allowed ? (
        <Alert tone="info">{t("adminsOnly")}</Alert>
      ) : (
        <>
          {securityOnly && <Alert tone="info">{t("securityOnly")}</Alert>}
          <div className="flex flex-wrap items-end justify-between gap-3">
            {!securityOnly && (
              <Field label={t("show")} htmlFor="audit-category" className="w-56">
                <Select
                  id="audit-category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value as AuditCategory | "")}
                >
                  <option value="">{t("everything")}</option>
                  {AUDIT_CATEGORIES.map((value) => (
                    <option key={value} value={value}>
                      {t(`categories.${value}`)}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <a
              className="text-sm underline underline-offset-4"
              href={wsPath(ws, "/audit-log.csv?days=90")}
            >
              {t("export")}
            </a>
          </div>
          {log.isLoading ? (
            <Loading rows={5} />
          ) : log.isError ? (
            <Alert tone="error">{errorMessage(log.error)}</Alert>
          ) : entries.length === 0 ? (
            <EmptyState title={t("emptyTitle")}>{t("emptyBody")}</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">{t("title")}</caption>
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    {[t("when"), t("who"), t("what"), t("detail")].map((heading) => (
                      <th key={heading} scope="col" className="px-2 py-2 font-medium">
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.id} className="border-b last:border-0 align-top">
                      <td className="whitespace-nowrap px-2 py-2">{formatDateTime(entry.at)}</td>
                      <td className="px-2 py-2">{entry.actor.label}</td>
                      <td className="px-2 py-2 font-mono text-xs">{entry.action}</td>
                      <td className="px-2 py-2 text-muted-foreground">
                        {entry.detail ?? entry.targetId ?? ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {log.hasNextPage && (
            <div>
              <Button
                variant="outline"
                disabled={log.isFetchingNextPage}
                onClick={() => void log.fetchNextPage()}
              >
                {t("more")}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
