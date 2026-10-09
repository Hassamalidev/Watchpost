/*
 * Who may open a status page (PRODUCT.md §6.6, Business): everyone, people who know its password,
 * or visitors from listed networks. The password is never shown again once saved.
 */
"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { STATUS_VISIBILITIES, type StatusPageView, type StatusVisibility } from "@app/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { ApiError, errorMessage } from "@/lib/api";
import { statusPageKeys, statusPagesApi } from "../api";

const problemOf = (err: unknown) => {
  const first = err instanceof ApiError ? err.fieldErrors[0] : undefined;
  return first ? first.message : errorMessage(err);
};

/* One address or network per line (commas work too). */
export const parseAllowedIps = (text: string): string[] =>
  text
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

export function AccessCard({ ws, page }: { ws: string; page: StatusPageView }) {
  const t = useTranslations("statusPages.access");
  const tc = useTranslations("common");
  const client = useQueryClient();
  const [visibility, setVisibility] = React.useState<StatusVisibility>(page.visibility);
  const [password, setPassword] = React.useState("");
  const [ips, setIps] = React.useState(page.allowedIps.join("\n"));
  const save = useMutation({
    mutationFn: () =>
      statusPagesApi.setAccess(ws, page.id, {
        visibility,
        ...(visibility === "password" && password !== "" ? { password } : {}),
        ...(visibility === "ip_allowlist" ? { allowedIps: parseAllowedIps(ips) } : {}),
      }),
    onSuccess: async (saved) => {
      setPassword("");
      setIps(saved.allowedIps.join("\n"));
      await client.invalidateQueries({ queryKey: statusPageKeys.all(ws) });
    },
  });
  const upgrade = save.error instanceof ApiError && save.error.status === 402;
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      {save.isError && <Alert tone={upgrade ? "info" : "error"}>{problemOf(save.error)}</Alert>}
      {save.isSuccess && <Alert tone="success">{t(`saved.${save.data.visibility}`)}</Alert>}
      <Field label={t("who")} htmlFor="spa-visibility">
        <Select
          id="spa-visibility"
          value={visibility}
          onChange={(e) => setVisibility(e.target.value as StatusVisibility)}
        >
          {STATUS_VISIBILITIES.map((value) => (
            <option key={value} value={value}>
              {t(`options.${value}`)}
            </option>
          ))}
        </Select>
      </Field>
      {visibility === "password" && (
        <Field
          label={t("password")}
          htmlFor="spa-password"
          hint={page.hasPassword ? t("passwordKeepHint") : t("passwordHint")}
        >
          <Input
            id="spa-password"
            type="password"
            value={password}
            minLength={8}
            maxLength={200}
            autoComplete="new-password"
            required={!page.hasPassword}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      )}
      {visibility === "ip_allowlist" && (
        <Field label={t("ips")} htmlFor="spa-ips" hint={t("ipsHint")}>
          <Textarea
            id="spa-ips"
            value={ips}
            rows={4}
            spellCheck={false}
            placeholder={"203.0.113.0/24\n2001:db8::/32"}
            className="font-mono"
            onChange={(e) => setIps(e.target.value)}
          />
        </Field>
      )}
      <div>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? tc("saving") : tc("save")}
        </Button>
      </div>
    </form>
  );
}
