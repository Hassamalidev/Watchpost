/*
 * A status page on the customer's own domain (PRODUCT.md §6.6): enter the domain, add the CNAME
 * record we show, and we check it. HTTPS is set up by itself once the record is found; until then
 * the domain serves nothing.
 */
"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { StatusPageView } from "@app/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/copy-field";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { statusPageKeys, statusPagesApi } from "../api";

const problemOf = (err: unknown) => {
  const first = err instanceof ApiError ? err.fieldErrors[0] : undefined;
  return first ? first.message : errorMessage(err);
};

export function DomainCard({ ws, page }: { ws: string; page: StatusPageView }) {
  const t = useTranslations("statusPages.domain");
  const tc = useTranslations("common");
  const client = useQueryClient();
  const [domain, setDomain] = React.useState(page.customDomain ?? "");
  const refresh = () => client.invalidateQueries({ queryKey: statusPageKeys.all(ws) });

  const save = useMutation({
    mutationFn: (value: string | null) => statusPagesApi.setDomain(ws, page.id, value),
    onSuccess: async (saved) => {
      setDomain(saved.customDomain ?? "");
      await refresh();
    },
  });
  const verify = useMutation({
    mutationFn: () => statusPagesApi.verifyDomain(ws, page.id),
    onSuccess: refresh,
  });

  if (page.cnameTarget === null) {
    return <p className="text-sm text-muted-foreground">{t("notAvailable")}</p>;
  }

  const verified = page.customDomain !== null && page.domainVerifiedAt !== null;
  const upgrade = save.error instanceof ApiError && save.error.status === 402;

  return (
    <div className="grid gap-4">
      {save.isError && <Alert tone={upgrade ? "info" : "error"}>{problemOf(save.error)}</Alert>}
      {verify.isError && <Alert tone="error">{problemOf(verify.error)}</Alert>}
      <form
        className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(domain.trim() === "" ? null : domain.trim().toLowerCase());
        }}
      >
        <Field label={t("domain")} htmlFor="spd-domain" hint={t("domainHint")}>
          <Input
            id="spd-domain"
            value={domain}
            placeholder="status.yourcompany.com"
            spellCheck={false}
            autoCapitalize="none"
            maxLength={253}
            onChange={(e) => setDomain(e.target.value)}
          />
        </Field>
        <div className="flex gap-2">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? tc("saving") : tc("save")}
          </Button>
          {page.customDomain !== null && (
            <Button
              type="button"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => {
                if (globalThis.confirm(t("confirmRemove", { domain: page.customDomain ?? "" }))) {
                  save.mutate(null);
                }
              }}
            >
              {t("remove")}
            </Button>
          )}
        </div>
      </form>

      {page.customDomain !== null && (
        <div className="grid gap-3 rounded-md border p-3 text-sm">
          {verified ? (
            <Alert tone="success">
              {t("verified", { domain: page.customDomain })}
              {page.domainError && <span className="block">{page.domainError}</span>}
            </Alert>
          ) : (
            <>
              <p className="font-medium">{t("stepsTitle")}</p>
              <ol className="grid list-decimal gap-2 pl-5">
                <li>{t("stepRecord")}</li>
                <li>{t("stepWait")}</li>
              </ol>
              <dl className="grid gap-3 sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-muted-foreground">{t("recordType")}</dt>
                  <dd className="font-mono">CNAME</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t("recordName")}</dt>
                  <dd className="break-all font-mono">{page.customDomain}</dd>
                </div>
              </dl>
              <CopyField label={t("recordValue")} value={page.cnameTarget} />
              {page.domainError && <Alert tone="info">{page.domainError}</Alert>}
            </>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={verify.isPending}
              onClick={() => verify.mutate()}
            >
              {verify.isPending ? t("checking") : t("checkNow")}
            </Button>
            {page.domainCheckedAt && (
              <span className="text-xs text-muted-foreground">
                {t("lastChecked", { time: formatDateTime(page.domainCheckedAt) })}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
