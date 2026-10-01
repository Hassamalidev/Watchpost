/*
 * Create a monitor: type, target and the common settings. The request is checked with the API's own
 * schema (createMonitorSchema) before it is sent, and the API's field errors land on the same inputs.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { useTranslations } from "next-intl";
import { DNS_RECORD_TYPES, LAUNCH_REGIONS, SEVERITIES, createMonitorSchema } from "@app/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { ApiError, errorMessage } from "@/lib/api";
import { workspaceHref } from "@/lib/navigation";
import type { CreateMonitorBody } from "../api";
import { useCreateMonitor } from "../hooks";

const FORM_TYPES = ["http", "keyword", "tcp", "ping", "dns", "ssl", "domain"] as const;
type FormType = (typeof FORM_TYPES)[number];
const INTERVALS = [180, 300, 600, 900, 1_800, 3_600];

interface Values {
  type: FormType;
  name: string;
  url: string;
  keyword: string;
  keywordMode: "contains" | "not_contains";
  host: string;
  port: string;
  recordType: (typeof DNS_RECORD_TYPES)[number];
  intervalSeconds: string;
  regions: string[];
  severity: (typeof SEVERITIES)[number];
  sloTarget: string;
}

/* Common availability targets and the downtime each allows in a 30-day month. */
const SLO_TARGETS = ["99", "99.5", "99.9", "99.95", "99.99"] as const;
const monthlyAllowance = (target: string) => {
  const minutes = ((100 - Number(target)) / 100) * 30 * 24 * 60;
  return minutes >= 60 ? `${(minutes / 60).toFixed(1)} h` : `${Math.round(minutes)} min`;
};

/* Form field for each API path, so schema and server errors show next to the right input. */
const FIELD_OF: Record<string, keyof Values> = {
  "settings.name": "name",
  "settings.intervalSeconds": "intervalSeconds",
  "settings.regions": "regions",
  "config.url": "url",
  "config.keyword": "keyword",
  "config.host": "host",
  "config.hostname": "host",
  "config.domain": "host",
  "config.port": "port",
};

function toBody(v: Values): CreateMonitorBody {
  const settings = {
    name: v.name.trim(),
    intervalSeconds: Number(v.intervalSeconds),
    regions: v.regions,
    severity: v.severity,
    sloTarget: Number(v.sloTarget),
  };
  const url = v.url.trim();
  const host = v.host.trim();
  switch (v.type) {
    case "http":
      return { settings, config: { type: "http", url } };
    case "keyword":
      return {
        settings,
        config: { type: "keyword", url, keyword: v.keyword, mode: v.keywordMode },
      };
    case "tcp":
      return { settings, config: { type: "tcp", host, port: Number(v.port) } };
    case "ping":
      return { settings, config: { type: "ping", host } };
    case "dns":
      return { settings, config: { type: "dns", hostname: host, recordType: v.recordType } };
    case "ssl":
      return { settings, config: { type: "ssl", host, port: Number(v.port || 443) } };
    case "domain":
      return { settings, config: { type: "domain", domain: host } };
  }
}

export function MonitorForm({ ws }: { ws: string }) {
  const t = useTranslations("monitors");
  const tc = useTranslations("common");
  const router = useRouter();
  const create = useCreateMonitor(ws);
  const [formError, setFormError] = React.useState<string | null>(null);
  const form = useForm<Values>({
    defaultValues: {
      type: "http",
      name: "",
      url: "https://",
      keyword: "",
      keywordMode: "contains",
      host: "",
      port: "443",
      recordType: "A",
      intervalSeconds: "300",
      regions: ["eu-central", "us-east"],
      severity: "high",
      sloTarget: "99.9",
    },
  });
  const type = form.watch("type");
  const errors = form.formState.errors;
  const usesUrl = type === "http" || type === "keyword";
  const usesPort = type === "tcp" || type === "ssl";

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    const body = toBody(values);
    const parsed = createMonitorSchema.safeParse(body);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = FIELD_OF[issue.path.join(".")];
        if (field) form.setError(field, { message: issue.message });
        else setFormError(issue.message);
      }
      return;
    }
    try {
      const monitor = await create.mutateAsync(body);
      router.push(workspaceHref(ws, `monitors/${monitor.id}`));
    } catch (err) {
      if (err instanceof ApiError) {
        for (const e of err.fieldErrors) {
          const field = FIELD_OF[e.path];
          if (field) form.setError(field, { message: e.message });
        }
      }
      setFormError(errorMessage(err));
    }
  });

  return (
    <form onSubmit={onSubmit} className="grid max-w-xl gap-4" noValidate>
      {formError && <Alert tone="error">{formError}</Alert>}
      <Field label={t("type")} htmlFor="monitor-type">
        <Select id="monitor-type" {...form.register("type")}>
          {FORM_TYPES.map((value) => (
            <option key={value} value={value}>
              {t(`types.${value}`)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("name")} htmlFor="monitor-name" error={errors.name?.message}>
        <Input id="monitor-name" autoComplete="off" {...form.register("name")} />
      </Field>
      {usesUrl ? (
        <Field label={t("url")} htmlFor="monitor-url" error={errors.url?.message}>
          <Input id="monitor-url" type="url" inputMode="url" {...form.register("url")} />
        </Field>
      ) : (
        <Field
          label={type === "domain" ? t("domain") : type === "dns" ? t("hostname") : t("host")}
          htmlFor="monitor-host"
          error={errors.host?.message}
        >
          <Input id="monitor-host" autoComplete="off" {...form.register("host")} />
        </Field>
      )}
      {usesPort && (
        <Field label={t("port")} htmlFor="monitor-port" error={errors.port?.message}>
          <Input id="monitor-port" inputMode="numeric" {...form.register("port")} />
        </Field>
      )}
      {type === "keyword" && (
        <>
          <Field label={t("keyword")} htmlFor="monitor-keyword" error={errors.keyword?.message}>
            <Input id="monitor-keyword" {...form.register("keyword")} />
          </Field>
          <Field label={t("keywordMode")} htmlFor="monitor-keyword-mode">
            <Select id="monitor-keyword-mode" {...form.register("keywordMode")}>
              <option value="contains">{t("missing")}</option>
              <option value="not_contains">{t("present")}</option>
            </Select>
          </Field>
        </>
      )}
      {type === "dns" && (
        <Field label={t("recordType")} htmlFor="monitor-record">
          <Select id="monitor-record" {...form.register("recordType")}>
            {DNS_RECORD_TYPES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field
        label={t("interval")}
        htmlFor="monitor-interval"
        error={errors.intervalSeconds?.message}
      >
        <Select id="monitor-interval" {...form.register("intervalSeconds")}>
          {INTERVALS.map((s) => (
            <option key={s} value={s}>
              {s < 3_600 ? t("minutes", { count: s / 60 }) : t("hours", { count: s / 3_600 })}
            </option>
          ))}
        </Select>
      </Field>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">{t("regions")}</legend>
        <p className="text-xs text-muted-foreground">{t("regionsHint")}</p>
        <div className="flex flex-wrap gap-4">
          {LAUNCH_REGIONS.map((region) => (
            <label key={region} className="flex items-center gap-2 text-sm">
              <input type="checkbox" value={region} {...form.register("regions")} />
              {region}
            </label>
          ))}
        </div>
        {errors.regions?.message && (
          <p role="alert" className="text-xs text-status-down">
            {errors.regions.message}
          </p>
        )}
      </fieldset>
      <Field label={t("severity")} htmlFor="monitor-severity">
        <Select id="monitor-severity" {...form.register("severity")}>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {t(`severities.${s}`)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("sloTarget")} htmlFor="monitor-slo" hint={t("sloHint")}>
        <Select id="monitor-slo" {...form.register("sloTarget")}>
          {SLO_TARGETS.map((target) => (
            <option key={target} value={target}>
              {t("sloOption", { target, allowance: monthlyAllowance(target) })}
            </option>
          ))}
        </Select>
      </Field>
      <div>
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? tc("saving") : tc("create")}
        </Button>
      </div>
    </form>
  );
}
