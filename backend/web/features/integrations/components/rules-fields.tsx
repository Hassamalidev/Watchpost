/*
 * A channel's own rules: from which severity up, and which events. A pager can take only high and
 * critical incidents while chat gets everything.
 */
"use client";

import { useTranslations } from "next-intl";
import { ALERT_EVENT_KINDS, STATE_SYNC_EVENTS, type ChannelRules } from "@app/shared";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/input";

/* Lowest first: each option includes everything above it. */
const SEVERITY_OPTIONS = ["low", "high", "critical"] as const;

export function RulesFields({
  value,
  onChange,
  syncsState = false,
}: {
  value: ChannelRules;
  onChange: (rules: ChannelRules) => void;
  /* The tool mirrors the incident's state: acknowledgements and recoveries always follow Down. */
  syncsState?: boolean;
}) {
  const t = useTranslations("integrations");
  return (
    <fieldset className="grid gap-3 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">{t("rulesTitle")}</legend>
      <p className="text-xs text-muted-foreground">{t("rulesIntro")}</p>
      <Field label={t("severityLabel")} htmlFor="channel-severity" hint={t("severityHint")}>
        <Select
          id="channel-severity"
          value={value.minSeverity}
          onChange={(e) =>
            onChange({ ...value, minSeverity: e.target.value as ChannelRules["minSeverity"] })
          }
        >
          {SEVERITY_OPTIONS.map((severity) => (
            <option key={severity} value={severity}>
              {t(`severity.${severity}`)}
            </option>
          ))}
        </Select>
      </Field>
      <fieldset className="grid gap-1.5">
        <legend className="mb-1.5 text-sm font-medium">{t("eventsLabel")}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {ALERT_EVENT_KINDS.map((kind) => {
            const locked = syncsState && STATE_SYNC_EVENTS.includes(kind);
            return (
              <label key={kind} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  disabled={locked}
                  checked={locked ? value.events.triggered : value.events[kind]}
                  onChange={(e) =>
                    onChange({ ...value, events: { ...value.events, [kind]: e.target.checked } })
                  }
                />
                {t(`events.${kind}`)}
              </label>
            );
          })}
        </div>
        {syncsState && <p className="text-xs text-muted-foreground">{t("syncHint")}</p>}
      </fieldset>
    </fieldset>
  );
}
