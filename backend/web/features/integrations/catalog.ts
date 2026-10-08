/*
 * What the web app adds to the shared integration catalog: searching the gallery, turning a setup
 * form's text inputs into a channel config (and back, for editing), and summing up a channel's rules.
 * Pure functions, so the forms stay thin and this logic is unit-tested.
 */
import {
  ALERT_EVENT_KINDS,
  INTEGRATIONS,
  SECRET_MASK,
  type AlertEventKind,
  type ChannelField,
  type ChannelRules,
  type IntegrationCategory,
  type IntegrationDefinition,
  type IntegrationId,
} from "@app/shared";

/* Brand-neutral tiles: two or three letters instead of logos we don't own. */
export const MONOGRAMS: Record<IntegrationId, string> = {
  slack: "Sl",
  "slack-webhook": "Sl",
  teams: "Te",
  discord: "Di",
  telegram: "Tg",
  "google-chat": "GC",
  mattermost: "Mm",
  rocketchat: "RC",
  zulip: "Zu",
  matrix: "[m]",
  pagerduty: "PD",
  opsgenie: "Og",
  "jira-service-management": "JSM",
  "splunk-on-call": "SO",
  pushover: "Po",
  sms: "Sm",
  voice: "Vc",
  ntfy: "nt",
  pushbullet: "Pb",
  gotify: "Go",
  "home-assistant": "HA",
  email: "@",
  webhook: "{ }",
  zapier: "Zp",
  make: "Mk",
  n8n: "n8n",
};

export type CategoryFilter = IntegrationCategory | "all";

/*
 * Gallery search: every word of the query must appear in the entry's name, keywords, category or
 * summary. `textOf` supplies the translated category label and summary.
 */
export function searchIntegrations(
  query: string,
  category: CategoryFilter,
  textOf: (integration: IntegrationDefinition) => string = () => "",
): IntegrationDefinition[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return INTEGRATIONS.filter((integration) => {
    if (category !== "all" && integration.category !== category) return false;
    if (words.length === 0) return true;
    const haystack = [
      integration.name,
      integration.id,
      integration.category,
      ...integration.keywords,
      textOf(integration),
    ]
      .join(" ")
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export type FormValues = Record<string, string>;

export function formatHeaderLines(headers: unknown): string {
  if (headers === null || typeof headers !== "object") return "";
  return Object.entries(headers as Record<string, unknown>)
    .map(([name, value]) => `${name}: ${String(value)}`)
    .join("\n");
}

/* "Name: value" lines → headers. Lines without a name or a value are returned as `invalid`. */
export function parseHeaderLines(text: string): {
  headers: Record<string, string>;
  invalid: string[];
} {
  const headers: Record<string, string> = {};
  const invalid: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const at = line.indexOf(":");
    const name = at > 0 ? line.slice(0, at).trim() : "";
    const value = at > 0 ? line.slice(at + 1).trim() : "";
    if (name === "" || value === "") invalid.push(line);
    else headers[name] = value;
  }
  return { headers, invalid };
}

/* True when the API answered a stored secret with its mask (or a secret URL with its origin). */
export function hasSavedSecret(field: ChannelField, config: Record<string, unknown>): boolean {
  const value = config[field.key];
  return field.secret === true && typeof value === "string" && value.includes(SECRET_MASK);
}

/* The form's starting text for each field: defaults when creating, the saved config when editing. */
export function initialValues(
  fields: readonly ChannelField[],
  config?: Record<string, unknown>,
): FormValues {
  const values: FormValues = {};
  for (const field of fields) {
    const saved = config?.[field.key];
    if (field.secret === true) values[field.key] = "";
    else if (field.kind === "headers") values[field.key] = formatHeaderLines(saved);
    else if (field.kind === "emails") {
      values[field.key] = Array.isArray(saved) ? saved.join(", ") : "";
    } else values[field.key] = typeof saved === "string" ? saved : (field.defaultValue ?? "");
  }
  return values;
}

/*
 * The config to send. Empty inputs are left out: for a saved secret that means "keep it", for an
 * optional setting "not set". `removed` lists optional secrets the user asked to delete (sent as null).
 */
export function toConfig(
  fields: readonly ChannelField[],
  values: FormValues,
  options: { preset?: Readonly<Record<string, string>>; removed?: ReadonlySet<string> } = {},
): { config: Record<string, unknown>; errors: Record<string, "headers"> } {
  const config: Record<string, unknown> = { ...options.preset };
  const errors: Record<string, "headers"> = {};
  for (const field of fields) {
    const text = (values[field.key] ?? "").trim();
    if (options.removed?.has(field.key)) {
      config[field.key] = null;
    } else if (field.kind === "emails") {
      config[field.key] = text.split(/[\s,;]+/).filter(Boolean);
    } else if (field.kind === "headers") {
      const { headers, invalid } = parseHeaderLines(text);
      if (invalid.length > 0) errors[field.key] = "headers";
      else if (Object.keys(headers).length > 0) config[field.key] = headers;
    } else if (text !== "") {
      config[field.key] = text;
    }
  }
  return { config, errors };
}

/* The form field an API error path points at: `body.config.headers.X-Team` → `headers`. */
export function fieldOfPath(path: string): string | undefined {
  if (path === "body.name") return "name";
  const match = /^body\.config\.([^.]+)/.exec(path);
  return match?.[1];
}

export const DEFAULT_RULES: ChannelRules = {
  events: { triggered: true, acknowledged: true, resolved: true, reminder: true, flapping: true },
  minSeverity: "low",
};

/* On-call tools page people, so they start with high and critical incidents only. */
export function defaultRulesFor(integration: IntegrationDefinition): ChannelRules {
  return integration.category === "oncall"
    ? { ...DEFAULT_RULES, minSeverity: "high" }
    : DEFAULT_RULES;
}

/* What a channel's rules leave out, for a one-line summary; null when it takes everything. */
export function rulesSummary(
  rules: ChannelRules,
): { severity: ChannelRules["minSeverity"]; without: AlertEventKind[] } | null {
  const without = ALERT_EVENT_KINDS.filter((kind) => !rules.events[kind]);
  if (rules.minSeverity === "low" && without.length === 0) return null;
  return { severity: rules.minSeverity, without };
}
