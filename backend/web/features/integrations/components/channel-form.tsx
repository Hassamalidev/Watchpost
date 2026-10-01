/*
 * One form for every integration, built from the catalog's field list: name, the integration's own
 * fields and the channel's rules. Creating and editing share it. Saved secrets are never shown: their
 * inputs start empty, and leaving one empty keeps the stored value (the API enforces the same).
 * Validation is the API's; its field errors land next to the matching inputs.
 */
"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import {
  CHANNEL_CAPABILITIES,
  integrationFields,
  type ChannelField,
  type ChannelRules,
  type IntegrationDefinition,
} from "@app/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { ApiError, errorMessage } from "@/lib/api";
import { integrationsApi, type ChannelDetail } from "../api";
import {
  defaultRulesFor,
  fieldOfPath,
  hasSavedSecret,
  initialValues,
  toConfig,
  type FormValues,
} from "../catalog";
import { PhoneVerify } from "./phone-verify";
import { RulesFields } from "./rules-fields";

/* Typed message keys can't be built from catalog data; a unit test checks every one exists. */
type Translate = (key: string, values?: Record<string, string>) => string;

function FieldInput({
  field,
  type,
  value,
  saved,
  maskedHeaders,
  error,
  disabled,
  onChange,
}: {
  field: ChannelField;
  type: string;
  value: string;
  /* What the API showed for a saved secret (its mask), when editing. */
  saved: string | undefined;
  /* Saved header values come back masked and are kept unless changed. */
  maskedHeaders: boolean;
  error: string | undefined;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const t = useTranslations("integrations");
  const text = t as unknown as Translate;
  const id = `channel-${field.key}`;
  const base = `fields.${type}.${field.key}`;
  const hint = t.has(`${base}.hint` as never) ? text(`${base}.hint`) : undefined;
  const savedHint = maskedHeaders
    ? t("headersSaved")
    : saved === undefined
      ? undefined
      : field.kind === "url"
        ? t("secretUrlSaved", { value: saved })
        : t("secretSaved");
  const common = {
    id,
    value,
    disabled,
    required: field.required && field.defaultValue === undefined && saved === undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      onChange(e.target.value),
  };

  return (
    <Field
      label={text(`${base}.label`)}
      htmlFor={id}
      hint={[hint, savedHint].filter(Boolean).join(" ") || undefined}
      error={error}
    >
      {field.kind === "select" ? (
        <Select {...common}>
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {text(`${base}.options.${option}`)}
            </option>
          ))}
        </Select>
      ) : field.kind === "headers" ? (
        <Textarea
          {...common}
          rows={3}
          spellCheck={false}
          placeholder={field.placeholder}
          className="font-mono text-xs"
        />
      ) : (
        <Input
          {...common}
          type={
            field.kind === "secret"
              ? "password"
              : field.kind === "url"
                ? "url"
                : field.kind === "phone"
                  ? "tel"
                  : "text"
          }
          inputMode={
            field.kind === "url"
              ? "url"
              : field.kind === "emails"
                ? "email"
                : field.kind === "phone"
                  ? "tel"
                  : undefined
          }
          autoComplete="off"
          spellCheck={false}
          placeholder={saved === undefined ? field.placeholder : undefined}
        />
      )}
    </Field>
  );
}

export function ChannelForm({
  ws,
  integration,
  channel,
  defaultName,
  defaults,
  submitLabel,
  onSaved,
}: {
  ws: string;
  integration: IntegrationDefinition;
  /* Set when editing. */
  channel?: ChannelDetail;
  defaultName?: string;
  /* Starting text for fields when creating (the signed-in user's address for email). */
  defaults?: FormValues;
  submitLabel: string;
  /* Runs after the API accepted the channel; may navigate. Errors it throws show in the form. */
  onSaved: (channel: ChannelDetail) => void | Promise<void>;
}) {
  const t = useTranslations("integrations");
  const fields = integrationFields(integration);
  const [name, setName] = React.useState(channel?.name ?? defaultName ?? integration.name);
  const [values, setValues] = React.useState<FormValues>(() => ({
    ...initialValues(fields, channel?.config),
    ...(channel ? {} : defaults),
  }));
  const [rules, setRules] = React.useState<ChannelRules>(
    channel?.rules ?? defaultRulesFor(integration),
  );
  const [removed, setRemoved] = React.useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [savedNotice, setSavedNotice] = React.useState(false);

  async function submit() {
    setFormError(null);
    setErrors({});
    setSavedNotice(false);
    const built = toConfig(fields, values, {
      removed,
      ...(integration.preset ? { preset: integration.preset } : {}),
    });
    if (Object.keys(built.errors).length > 0) {
      setErrors(Object.fromEntries(Object.keys(built.errors).map((k) => [k, t("headersInvalid")])));
      return;
    }
    setBusy(true);
    try {
      const body = { name: name.trim() || integration.name, config: built.config, rules };
      /* The Slack app and Telegram have no form fields: their config is set by connecting. */
      const { config: _config, ...withoutConfig } = body;
      if (channel === undefined) {
        /* The caller leaves this page; the button stays busy until it does. */
        await onSaved(await integrationsApi.createChannel(ws, { type: integration.type, ...body }));
        return;
      }
      const saved = await integrationsApi.updateChannel(
        ws,
        channel.id,
        fields.length === 0 ? withoutConfig : body,
      );
      /* What was typed is stored now; the inputs go back to "saved". */
      setValues(initialValues(fields, saved.config));
      setRemoved(new Set());
      await onSaved(saved);
      setSavedNotice(true);
      setBusy(false);
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.fieldErrors.length > 0) {
        const next: Record<string, string> = {};
        /* A problem no input can show (rules, an unknown field) still needs saying. */
        let unplaced = false;
        for (const e of err.fieldErrors) {
          const key = fieldOfPath(e.path);
          if (key === undefined || !(key === "name" || fields.some((f) => f.key === key))) {
            unplaced = true;
          } else if (next[key] === undefined) next[key] = e.message;
        }
        setErrors(next);
        if (unplaced) setFormError(errorMessage(err));
      } else {
        setFormError(errorMessage(err));
      }
    }
  }

  return (
    <form
      className="grid max-w-xl gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {formError && <Alert tone="error">{formError}</Alert>}
      <Field label={t("name")} htmlFor="channel-name" hint={t("nameHint")} error={errors.name}>
        <Input
          id="channel-name"
          value={name}
          maxLength={100}
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      {fields.map((field) => {
        const saved =
          channel && hasSavedSecret(field, channel.config)
            ? String(channel.config[field.key])
            : undefined;
        return (
          <div key={field.key} className="grid gap-1.5">
            <FieldInput
              field={field}
              type={integration.type}
              value={values[field.key] ?? ""}
              saved={saved}
              maskedHeaders={field.kind === "headers" && channel?.config.headers !== undefined}
              error={errors[field.key]}
              disabled={removed.has(field.key)}
              onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
            />
            {field.kind === "phone" && values[field.key] !== channel?.config[field.key] && (
              <PhoneVerify ws={ws} phone={values[field.key] ?? ""} />
            )}
            {saved !== undefined && !field.required && (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={removed.has(field.key)}
                  onChange={(e) =>
                    setRemoved((current) => {
                      const next = new Set(current);
                      if (e.target.checked) next.add(field.key);
                      else next.delete(field.key);
                      return next;
                    })
                  }
                />
                {t("removeSecret")}
              </label>
            )}
          </div>
        );
      })}
      <RulesFields
        value={rules}
        onChange={setRules}
        syncsState={CHANNEL_CAPABILITIES[integration.type].followUps === "sync"}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? t("saving") : submitLabel}
        </Button>
        <span aria-live="polite" className="text-sm text-status-up">
          {savedNotice && t("saved")}
        </span>
      </div>
    </form>
  );
}
