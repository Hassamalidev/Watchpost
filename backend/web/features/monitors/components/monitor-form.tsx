/*
 * Create or edit a monitor: type, target and the common settings. The request is checked with the
 * API's own schema (createMonitorSchema) before it is sent, and the API's field errors land on the same
 * inputs. Editing keeps config the form doesn't show (headers, auth) and can't change the type.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { useTranslations } from "next-intl";
import {
  DNS_RECORD_TYPES,
  LAUNCH_REGIONS,
  SEVERITIES,
  createMonitorSchema,
  isPrivateRegion,
} from "@app/shared";
import { usePrivateProbes } from "@/features/settings/private-probes";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { ApiError, errorMessage } from "@/lib/api";
import { workspaceHref } from "@/lib/navigation";
import { monitorsApi, type CreateMonitorBody, type Monitor } from "../api";
import { monitorKeys, useCreateMonitor, useMonitorGroups, useMonitors } from "../hooks";

const FORM_TYPES = [
  "http",
  "keyword",
  "multistep",
  "tcp",
  "ping",
  "dns",
  "ssl",
  "domain",
  "redis",
  "mqtt",
  "grpc",
] as const;
type FormType = (typeof FORM_TYPES)[number];
/* Checks of services inside a network: offered once the workspace has a private probe. */
const PRIVATE_TYPES: readonly FormType[] = ["redis", "mqtt", "grpc"];
const DEFAULT_PORT: Partial<Record<FormType, string>> = {
  tcp: "443",
  ssl: "443",
  redis: "6379",
  mqtt: "1883",
  grpc: "443",
};
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
  /* Service checks (Redis, MQTT, gRPC). */
  tls: boolean;
  username: string;
  password: string;
  service: string;
  /* Multi-step checks: the steps as JSON, and secrets as name=value lines. */
  steps: string;
  secrets: string;
  intervalSeconds: string;
  regions: string[];
  minFailingRegions: string;
  alertOnRegionalIssue: boolean;
  severity: (typeof SEVERITIES)[number];
  sloTarget: string;
  /* A group ID, "" for none, or NEW_GROUP while a new one is being named. */
  groupId: string;
  newGroupName: string;
  groupAlerts: boolean;
  /* The monitor this one depends on; "" for none. */
  parentId: string;
}

const NEW_GROUP = "__new__";

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
  "settings.groupId": "groupId",
  "settings.parentId": "parentId",
  "config.url": "url",
  "config.keyword": "keyword",
  "config.host": "host",
  "config.hostname": "host",
  "config.domain": "host",
  "config.port": "port",
};
/* Anything inside a multi-step check's steps or secrets belongs to that one box. */
const fieldFor = (path: string): keyof Values | undefined =>
  path.startsWith("config.steps")
    ? "steps"
    : path.startsWith("config.secrets")
      ? "secrets"
      : FIELD_OF[path];

const EXAMPLE_STEPS = `[
  {
    "name": "Sign in",
    "url": "https://api.example.com/login",
    "method": "POST",
    "headers": [{ "name": "content-type", "value": "application/json" }],
    "body": "{\\"user\\":\\"monitor\\",\\"password\\":\\"{{password}}\\"}",
    "extract": [{ "name": "token", "expression": "token" }]
  },
  {
    "name": "Read profile",
    "url": "https://api.example.com/me",
    "headers": [{ "name": "Authorization", "value": "Bearer {{token}}" }],
    "assertions": [{ "expression": "status", "operator": "==", "expected": "active" }]
  }
]`;

/* "name=value" lines as the API's list; the value may contain "=". */
export function parseSecretLines(text: string): Array<{ name: string; value: string }> {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const at = line.indexOf("=");
      return at < 0
        ? { name: line, value: "" }
        : { name: line.slice(0, at).trim(), value: line.slice(at + 1) };
    });
}

function toBody(v: Values): CreateMonitorBody {
  const settings = {
    name: v.name.trim(),
    intervalSeconds: Number(v.intervalSeconds),
    regions: v.regions,
    /* Never more regions than are checked. */
    minFailingRegions: Math.max(1, Math.min(Number(v.minFailingRegions), v.regions.length)),
    alertOnRegionalIssue: v.regions.length > 1 && v.alertOnRegionalIssue,
    severity: v.severity,
    sloTarget: Number(v.sloTarget),
  };
  const url = v.url.trim();
  const host = v.host.trim();
  switch (v.type) {
    case "multistep": {
      /* Unreadable JSON goes on as text, so the schema's error lands on the steps box. */
      let steps: unknown = v.steps;
      try {
        steps = JSON.parse(v.steps);
      } catch {
        /* Reported by the schema below. */
      }
      return {
        settings,
        config: { type: "multistep", steps, secrets: parseSecretLines(v.secrets) },
      } as CreateMonitorBody;
    }
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
    case "redis":
    case "mqtt":
      return {
        settings,
        config: {
          type: v.type,
          host,
          port: Number(v.port),
          tls: v.tls,
          ...(v.username.trim() === "" ? {} : { username: v.username.trim() }),
          ...(v.password === "" ? {} : { password: v.password }),
        },
      };
    case "grpc":
      return {
        settings,
        config: { type: "grpc", host, port: Number(v.port), tls: v.tls, service: v.service.trim() },
      };
  }
}

/* How the API shows a saved credential (basic password, bearer token, secret header). */
const MASKED = "********";

/* Where requests go: a URL's origin, or host and port. */
function targetKey(v: Pick<Values, "url" | "host" | "port">, usesUrl: boolean): string {
  if (!usesUrl) return `${v.host.trim().toLowerCase()}:${v.port}`;
  try {
    return new URL(v.url.trim()).origin;
  } catch {
    return v.url.trim();
  }
}

/* The config without its saved credentials, for pointing the monitor somewhere new. */
function withoutSavedSecrets(config: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...config };
  const auth = copy.auth as Record<string, unknown> | undefined;
  if (auth && Object.values(auth).includes(MASKED)) delete copy.auth;
  if (Array.isArray(copy.headers)) {
    copy.headers = (copy.headers as Array<{ value: string }>).filter((h) => h.value !== MASKED);
  }
  return copy;
}

const DEFAULTS: Values = {
  type: "http",
  name: "",
  url: "https://",
  keyword: "",
  keywordMode: "contains",
  host: "",
  port: "443",
  recordType: "A",
  tls: false,
  username: "",
  password: "",
  service: "",
  steps: EXAMPLE_STEPS,
  secrets: "",
  intervalSeconds: "300",
  regions: ["eu-central", "us-east"],
  minFailingRegions: "2",
  alertOnRegionalIssue: false,
  severity: "high",
  sloTarget: "99.9",
  groupId: "",
  newGroupName: "",
  groupAlerts: false,
  parentId: "",
};

/* Form values for an existing monitor. */
function valuesOf(monitor: Monitor): Values {
  const c = monitor.config;
  const text = (key: string) => (typeof c[key] === "string" ? (c[key] as string) : "");
  return {
    ...DEFAULTS,
    type: (FORM_TYPES as readonly string[]).includes(monitor.type)
      ? (monitor.type as FormType)
      : "http",
    name: monitor.name,
    url: text("url") || DEFAULTS.url,
    keyword: text("keyword"),
    keywordMode: c.mode === "not_contains" ? "not_contains" : "contains",
    host: text("host") || text("hostname") || text("domain"),
    port: typeof c.port === "number" ? String(c.port) : DEFAULTS.port,
    recordType: (DNS_RECORD_TYPES as readonly string[]).includes(text("recordType"))
      ? (text("recordType") as Values["recordType"])
      : "A",
    tls: c.tls === true,
    username: text("username"),
    /* A saved password comes back masked; sending the mask back keeps it. */
    password: text("password"),
    service: text("service"),
    steps: Array.isArray(c.steps) ? JSON.stringify(c.steps, null, 2) : DEFAULTS.steps,
    /* Saved secrets come back masked; sending the mask back keeps them. */
    secrets: Array.isArray(c.secrets)
      ? (c.secrets as Array<{ name: string; value: string }>)
          .map((secret) => `${secret.name}=${secret.value}`)
          .join("\n")
      : "",
    intervalSeconds: String(monitor.intervalSeconds),
    regions: monitor.regions,
    minFailingRegions: String(monitor.minFailingRegions ?? 2),
    alertOnRegionalIssue: monitor.alertOnRegionalIssue ?? false,
    severity: monitor.severity,
    sloTarget: String(monitor.sloTarget ?? 99.9),
    groupId: monitor.groupId ?? "",
    parentId: monitor.parentId ?? "",
  };
}

export function MonitorForm({ ws, monitor }: { ws: string; monitor?: Monitor }) {
  const t = useTranslations("monitors");
  const tc = useTranslations("common");
  const router = useRouter();
  const create = useCreateMonitor(ws);
  const client = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);
  const [dropSecrets, setDropSecrets] = React.useState(false);
  const form = useForm<Values>({ defaultValues: monitor ? valuesOf(monitor) : DEFAULTS });
  const groups = useMonitorGroups(ws);
  const others = useMonitors(ws);
  const groupId = form.watch("groupId");
  /* The checkbox shows the chosen group's own setting until the user changes it. */
  React.useEffect(() => {
    const chosen = groups.data?.find((g) => g.id === groupId);
    form.setValue("groupAlerts", chosen?.groupAlerts ?? false);
  }, [groupId, groups.data, form]);
  const privateProbes = usePrivateProbes(ws);
  const type = form.watch("type");
  const errors = form.formState.errors;
  const regionCount = form.watch("regions").length;
  /* A monitor runs from our regions or on one private probe, never both. */
  const privateRegion = form.watch("regions").find(isPrivateRegion);
  const usesUrl = type === "http" || type === "keyword";
  const isService = (PRIVATE_TYPES as readonly string[]).includes(type);
  const usesPort = type === "tcp" || type === "ssl" || isService;
  const hasProbes = (privateProbes.data ?? []).length > 0;
  /* A service check runs on a private probe: picking the type picks the first probe and its port. */
  const firstProbeRegion = privateProbes.data?.[0]?.region;
  React.useEffect(() => {
    if (monitor !== undefined) return;
    const port = DEFAULT_PORT[type];
    if (port !== undefined) form.setValue("port", port);
    form.setValue("tls", type === "grpc");
    if ((PRIVATE_TYPES as readonly string[]).includes(type) && firstProbeRegion !== undefined) {
      if (!form.getValues("regions").some(isPrivateRegion)) {
        form.setValue("regions", [firstProbeRegion]);
      }
    }
  }, [type, monitor, form, firstProbeRegion]);
  /* Saved credentials stay with the target they were entered for (the API enforces it too). */
  const hasSavedSecrets = monitor !== undefined && JSON.stringify(monitor.config).includes(MASKED);
  const retargeted =
    monitor !== undefined &&
    targetKey(
      { url: form.watch("url"), host: form.watch("host"), port: form.watch("port") },
      usesUrl,
    ) !== targetKey(valuesOf(monitor), usesUrl);
  const needsSecretChoice = hasSavedSecrets && retargeted;

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    const body = toBody(values);
    const parsed = createMonitorSchema.safeParse(body);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = fieldFor(issue.path.join("."));
        if (field) form.setError(field, { message: issue.message });
        else setFormError(issue.message);
      }
      return;
    }
    try {
      if (monitor && needsSecretChoice && !dropSecrets) {
        setFormError(t("secretsRetargetRequired"));
        return;
      }
      /* The group first: a new one is created, and a changed "one message" choice is saved. */
      let chosenGroup = values.groupId;
      if (chosenGroup === NEW_GROUP) {
        const name = values.newGroupName.trim();
        if (name === "") {
          form.setError("newGroupName", { message: t("groupNameRequired") });
          return;
        }
        chosenGroup = (await monitorsApi.createGroup(ws, { name, groupAlerts: values.groupAlerts }))
          .id;
        form.setValue("groupId", chosenGroup);
      } else if (chosenGroup !== "") {
        const existing = groups.data?.find((g) => g.id === chosenGroup);
        if (existing && existing.groupAlerts !== values.groupAlerts) {
          await monitorsApi.updateGroup(ws, existing.id, {
            name: existing.name,
            groupAlerts: values.groupAlerts,
          });
        }
      }
      await client.invalidateQueries({ queryKey: monitorKeys.groups(ws) });
      const links = {
        ...(chosenGroup === "" ? {} : { groupId: chosenGroup }),
        ...(values.parentId === "" ? {} : { parentId: values.parentId }),
      };
      if (monitor) {
        const merged = { ...monitor.config, ...body.config };
        await monitorsApi.update(ws, monitor.id, {
          /* null removes a link the monitor had. */
          settings: {
            ...body.settings,
            groupId: chosenGroup === "" ? null : chosenGroup,
            parentId: values.parentId === "" ? null : values.parentId,
          },
          config: needsSecretChoice ? withoutSavedSecrets(merged) : merged,
        });
        await client.invalidateQueries({ queryKey: monitorKeys.all(ws) });
        await client.invalidateQueries({ queryKey: ["error-budget", ws, monitor.id] });
        await client.invalidateQueries({ queryKey: ["error-budgets", ws] });
        router.push(workspaceHref(ws, `monitors/${monitor.id}`));
        return;
      }
      const created = await create.mutateAsync({
        ...body,
        settings: { ...body.settings, ...links },
      });
      router.push(workspaceHref(ws, `monitors/${created.id}`));
    } catch (err) {
      if (err instanceof ApiError) {
        for (const e of err.fieldErrors) {
          const field = fieldFor(e.path);
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
        <Select id="monitor-type" disabled={monitor !== undefined} {...form.register("type")}>
          {FORM_TYPES.filter(
            (value) => hasProbes || value === type || !PRIVATE_TYPES.includes(value),
          ).map((value) => (
            <option key={value} value={value}>
              {t(`types.${value}`)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("name")} htmlFor="monitor-name" error={errors.name?.message}>
        <Input id="monitor-name" autoComplete="off" {...form.register("name")} />
      </Field>
      {type === "multistep" ? (
        <>
          <Field
            label={t("steps")}
            htmlFor="monitor-steps"
            hint={t("stepsHint")}
            error={errors.steps?.message}
          >
            <Textarea
              id="monitor-steps"
              rows={16}
              spellCheck={false}
              className="font-mono text-xs"
              {...form.register("steps")}
            />
          </Field>
          <Field
            label={t("stepSecrets")}
            htmlFor="monitor-secrets"
            hint={t("stepSecretsHint")}
            error={errors.secrets?.message}
          >
            <Textarea
              id="monitor-secrets"
              rows={3}
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-xs"
              placeholder="password=…"
              {...form.register("secrets")}
            />
          </Field>
        </>
      ) : usesUrl ? (
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
      {isService && (
        <>
          <label className="flex min-h-6 items-center gap-2 text-sm">
            <input type="checkbox" {...form.register("tls")} />
            {t("useTls")}
          </label>
          {type === "grpc" ? (
            <Field label={t("grpcService")} htmlFor="monitor-service" hint={t("grpcServiceHint")}>
              <Input id="monitor-service" autoComplete="off" {...form.register("service")} />
            </Field>
          ) : (
            <>
              <Field label={t("serviceUsername")} htmlFor="monitor-username">
                <Input id="monitor-username" autoComplete="off" {...form.register("username")} />
              </Field>
              <Field
                label={t("servicePassword")}
                htmlFor="monitor-password"
                hint={t("servicePasswordHint")}
              >
                <Input
                  id="monitor-password"
                  type="password"
                  autoComplete="new-password"
                  {...form.register("password")}
                />
              </Field>
            </>
          )}
        </>
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
        {(privateProbes.data ?? []).length > 0 && (
          <Field label={t("runOn")} htmlFor="monitor-location" hint={t("runOnHint")}>
            <Select
              id="monitor-location"
              value={privateRegion ?? ""}
              onChange={(e) =>
                form.setValue(
                  "regions",
                  e.target.value === "" ? ["eu-central", "us-east"] : [e.target.value],
                  { shouldDirty: true },
                )
              }
            >
              <option value="">{t("runOnRegions")}</option>
              {(privateProbes.data ?? []).map((probe) => (
                <option key={probe.id} value={probe.region}>
                  {t("runOnProbe", { name: probe.name })}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {privateRegion === undefined && (
          <div className="flex flex-wrap gap-4">
            {LAUNCH_REGIONS.map((region) => (
              <label key={region} className="flex items-center gap-2 text-sm">
                <input type="checkbox" value={region} {...form.register("regions")} />
                {region}
              </label>
            ))}
          </div>
        )}
        {errors.regions?.message && (
          <p role="alert" className="text-xs text-status-down">
            {errors.regions.message}
          </p>
        )}
      </fieldset>
      {regionCount > 1 && (
        <>
          <Field
            label={t("confirmRegions")}
            htmlFor="monitor-confirm-regions"
            hint={t("confirmRegionsHint")}
          >
            <Select id="monitor-confirm-regions" {...form.register("minFailingRegions")}>
              {Array.from({ length: regionCount }, (_, index) => (
                <option key={index + 1} value={String(index + 1)}>
                  {t("confirmRegionsOption", { count: index + 1 })}
                </option>
              ))}
            </Select>
          </Field>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" {...form.register("alertOnRegionalIssue")} />
            <span>
              {t("alertRegional")}
              <span className="block text-xs text-muted-foreground">{t("alertRegionalHint")}</span>
            </span>
          </label>
        </>
      )}
      <Field label={t("severity")} htmlFor="monitor-severity">
        <Select id="monitor-severity" {...form.register("severity")}>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {t(`severities.${s}`)}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label={t("dependsOn")}
        htmlFor="monitor-parent"
        hint={t("dependsOnHint")}
        error={errors.parentId?.message}
      >
        <Select id="monitor-parent" {...form.register("parentId")}>
          <option value="">{t("dependsOnNone")}</option>
          {(others.data ?? [])
            .filter((m) => m.id !== monitor?.id)
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
        </Select>
      </Field>
      <Field label={t("group")} htmlFor="monitor-group" error={errors.groupId?.message}>
        <Select id="monitor-group" {...form.register("groupId")}>
          <option value="">{t("groupNone")}</option>
          {(groups.data ?? []).map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
          <option value={NEW_GROUP}>{t("groupNew")}</option>
        </Select>
      </Field>
      {groupId === NEW_GROUP && (
        <Field
          label={t("groupName")}
          htmlFor="monitor-group-name"
          error={errors.newGroupName?.message}
        >
          <Input id="monitor-group-name" maxLength={100} {...form.register("newGroupName")} />
        </Field>
      )}
      {groupId !== "" && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" {...form.register("groupAlerts")} />
          <span>
            {t("groupAlerts")}
            <span className="block text-xs text-muted-foreground">{t("groupAlertsHint")}</span>
          </span>
        </label>
      )}
      {needsSecretChoice && (
        <div className="grid gap-2 rounded-md border border-status-degraded/40 bg-status-degraded/10 p-3 text-sm">
          <p>{t("secretsRetarget")}</p>
          <label className="flex items-center gap-2 font-medium">
            <input
              type="checkbox"
              checked={dropSecrets}
              onChange={(e) => setDropSecrets(e.target.checked)}
            />
            {t("secretsDrop")}
          </label>
        </div>
      )}
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
          {form.formState.isSubmitting ? tc("saving") : monitor ? tc("save") : tc("create")}
        </Button>
      </div>
    </form>
  );
}
