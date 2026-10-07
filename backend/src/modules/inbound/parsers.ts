/*
 * Turns each tool's alert payload into our inbound events (PRODUCT.md §6.8). Pure functions; a
 * payload that can't be read throws a ValidationError saying what is missing, which the sender sees
 * as a 400.
 *
 * - Generic JSON: our own shape (`genericInboundSchema`).
 * - Alertmanager webhook (version 4) and Grafana unified alerting, which posts the same `alerts`
 *   array: one event per alert, keyed by its fingerprint.
 * - Datadog: the payload template we give out (`DATADOG_PAYLOAD_TEMPLATE`).
 * - Email: subject and text, as an inbound-mail provider posts them.
 */
import { createHash } from "node:crypto";
import {
  MAX_INBOUND_EVENTS,
  genericInboundSchema,
  type InboundEvent,
  type InboundKind,
  type Severity,
} from "@app/shared";
import { z } from "zod";
import { ValidationError } from "../../core/errors.js";

const fail = (message: string) => new ValidationError(message, [{ path: "body", message }]);
const short = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
const clip = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value);
const httpUrl = (value: unknown): string | null =>
  typeof value === "string" && /^https?:\/\//i.test(value) ? clip(value, 2_000) : null;

function generic(payload: unknown): InboundEvent[] {
  const parsed = genericInboundSchema.safeParse(payload);
  if (!parsed.success) {
    throw fail(
      'Send JSON with at least a "title"; "status" is "trigger" or "resolve", "severity" is critical, high or low.',
    );
  }
  const body = parsed.data;
  return [
    {
      status: body.status,
      key: body.dedup_key ?? short(body.title.toLowerCase()),
      title: body.title,
      severity: body.severity,
      description: body.description ?? null,
      link: body.links?.[0]?.href ?? null,
    },
  ];
}

const promAlert = z.object({
  status: z.string().optional(),
  labels: z.record(z.string(), z.string()).default({}),
  annotations: z.record(z.string(), z.string()).default({}),
  fingerprint: z.string().max(200).optional(),
  generatorURL: z.string().optional(),
});
const promPayload = z.object({
  status: z.string().optional(),
  alerts: z.array(promAlert).min(1),
});
/* Grafana's legacy alerting (before unified alerting) posts one state per rule. */
const grafanaLegacy = z.object({
  state: z.string(),
  ruleName: z.string().min(1),
  ruleId: z.union([z.number(), z.string()]).optional(),
  message: z.string().optional(),
  ruleUrl: z.string().optional(),
});

/* Prometheus convention: critical and page wake people; warning and info are low. */
function promSeverity(label: string | undefined): Severity {
  const value = (label ?? "").toLowerCase();
  if (value === "critical" || value === "page" || value === "p1" || value === "emergency") {
    return "critical";
  }
  if (value === "warning" || value === "info" || value === "low" || value === "notice")
    return "low";
  return "high";
}

function prometheus(payload: unknown, tool: string): InboundEvent[] {
  const parsed = promPayload.safeParse(payload);
  if (!parsed.success) {
    throw fail(`This doesn't look like a ${tool} webhook: there is no "alerts" list.`);
  }
  if (parsed.data.alerts.length > MAX_INBOUND_EVENTS) {
    throw fail(`At most ${MAX_INBOUND_EVENTS} alerts per request.`);
  }
  return parsed.data.alerts.map((alert) => {
    const name = alert.labels.alertname ?? "Alert";
    const where = alert.labels.instance ?? alert.labels.job;
    const labelsKey = Object.entries(alert.labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    return {
      status: (alert.status ?? parsed.data.status) === "resolved" ? "resolve" : "trigger",
      key: clip(alert.fingerprint ?? short(labelsKey), 200),
      title: clip(
        alert.annotations.summary ??
          alert.annotations.title ??
          (where === undefined ? name : `${name} (${where})`),
        200,
      ),
      severity: promSeverity(alert.labels.severity),
      description: alert.annotations.description ?? alert.annotations.message ?? null,
      link: httpUrl(alert.generatorURL),
    };
  });
}

function grafana(payload: unknown): InboundEvent[] {
  const legacy = grafanaLegacy.safeParse(payload);
  if (legacy.success && !promPayload.safeParse(payload).success) {
    const state = legacy.data.state.toLowerCase();
    return [
      {
        status: state === "ok" ? "resolve" : "trigger",
        key: String(legacy.data.ruleId ?? short(legacy.data.ruleName)),
        title: clip(legacy.data.ruleName, 200),
        severity: state === "no_data" ? "low" : "high",
        description: legacy.data.message ?? null,
        link: httpUrl(legacy.data.ruleUrl),
      },
    ];
  }
  return prometheus(payload, "Grafana");
}

const datadogPayload = z.object({
  alert_id: z.union([z.string().min(1), z.number()]),
  aggreg_key: z.string().optional(),
  transition: z.string().min(1),
  title: z.string().min(1),
  priority: z.string().optional(),
  body: z.string().optional(),
  link: z.string().optional(),
});

function datadog(payload: unknown): InboundEvent[] {
  const parsed = datadogPayload.safeParse(payload);
  if (!parsed.success) {
    throw fail(
      'This doesn\'t match the Datadog payload template: "alert_id", "transition" and "title" are needed.',
    );
  }
  const body = parsed.data;
  const priority = (body.priority ?? "").toUpperCase();
  return [
    {
      status: /recovered/i.test(body.transition) ? "resolve" : "trigger",
      key: clip(`${body.alert_id}:${body.aggreg_key ?? ""}`, 200),
      /* Datadog prefixes titles with the transition; the incident title shouldn't change with it. */
      title: clip(body.title.replace(/^\s*\[[^\]]{1,40}\]\s*/, ""), 200),
      severity:
        priority === "P1"
          ? "critical"
          : priority === "P4" || priority === "P5" || priority === "LOW"
            ? "low"
            : "high",
      description: body.body ?? null,
      link: httpUrl(body.link),
    },
  ];
}

const emailPayload = z.object({
  from: z.string().max(500).optional(),
  subject: z.string().trim().min(1).max(500),
  text: z.string().max(50_000).optional(),
});

const RECOVERY = /^(?:\[?\s*)?(?:resolved|recovered|recovery|ok|up|cleared|closed)\b/i;
const PROBLEM =
  /^(?:\[?\s*)?(?:firing|problem|alert|alarm|triggered|critical|down|warning|error)\b/i;
/* A state word in front, with its brackets, count and separator: "[FIRING:1] ", "RECOVERY: ". */
const STATE_PREFIX =
  /^\s*\[?\s*(?:resolved|recovered|recovery|ok|up|cleared|closed|firing|problem|alert|alarm|triggered|critical|down|warning|error)\s*(?::\s*\d+)?\s*\]?\s*[:\-–]?\s*/i;
/* A state word at the end: "… is CRITICAL", "… is OK". */
const STATE_SUFFIX = /\s+(?:is\s+)?(?:ok|up|critical|down|warning|unknown|recovered|resolved)\s*$/i;

function email(payload: unknown): InboundEvent[] {
  const parsed = emailPayload.safeParse(payload);
  if (!parsed.success) throw fail('An email needs a "subject".');
  const { subject, text, from } = parsed.data;
  const resolved =
    RECOVERY.test(subject) ||
    (!PROBLEM.test(subject) && /\s(?:is\s+)?(?:ok|up|recovered|resolved)\s*$/i.test(subject));
  /* The same subject without its state words identifies the problem on both emails. */
  const topic = subject.replace(STATE_PREFIX, "").replace(STATE_SUFFIX, "").trim() || subject;
  return [
    {
      status: resolved ? "resolve" : "trigger",
      key: short(`${(from ?? "").toLowerCase()}|${topic.toLowerCase()}`),
      title: clip(topic, 200),
      severity: "high",
      description: text === undefined ? null : clip(text, 10_000),
      link: null,
    },
  ];
}

export function parseInbound(kind: InboundKind, payload: unknown): InboundEvent[] {
  switch (kind) {
    case "generic":
      return generic(payload);
    case "alertmanager":
      return prometheus(payload, "Alertmanager");
    case "grafana":
      return grafana(payload);
    case "datadog":
      return datadog(payload);
    case "email":
      return email(payload);
  }
}
