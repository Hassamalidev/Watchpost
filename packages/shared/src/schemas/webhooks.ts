/*
 * Outbound webhooks (PRODUCT.md §6.13): a workspace subscribes an HTTPS endpoint to events and we
 * POST each one to it, signed. This file is the public contract: which events exist, what each one
 * carries, and how a custom body template is filled in. The API, the delivery worker, the web app
 * and the documentation all read it.
 */
import { z } from "zod";
import { webhookHeadersSchema } from "./channel-configs.js";

/* The events a workspace can subscribe to. Adding one is compatible; renaming one is not. */
export const WEBHOOK_EVENT_TYPES = [
  "incident.triggered",
  "incident.acknowledged",
  "incident.resolved",
  "incident.reopened",
  "monitor.created",
  "monitor.updated",
  "monitor.deleted",
  "monitor.state_changed",
  "status_page.update_published",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/* `incident.*` subscribes to every incident event, present and future; `*` to everything. */
export const WEBHOOK_EVENT_GROUPS = ["*", "incident.*", "monitor.*", "status_page.*"] as const;
export type WebhookEventPattern = WebhookEventType | (typeof WEBHOOK_EVENT_GROUPS)[number];

export function webhookEventMatches(patterns: readonly string[], type: string): boolean {
  return patterns.some(
    (pattern) =>
      pattern === "*" ||
      pattern === type ||
      (pattern.endsWith(".*") && type.startsWith(pattern.slice(0, -1))),
  );
}

export const WEBHOOKS_PER_WORKSPACE = 10;
export const WEBHOOK_TEMPLATE_MAX = 8_000;
/* When each attempt after a failed one is made, in minutes after the one before: about a day in all. */
export const WEBHOOK_RETRY_MINUTES = [1, 5, 15, 60, 180, 360, 720] as const;
/* An endpoint that fails this many deliveries in a row is switched off. */
export const WEBHOOK_DISABLE_AFTER_FAILURES = 20;
export const WEBHOOK_DELIVERY_DAYS = 30;

export const WEBHOOK_EVENT_DESCRIPTIONS: Record<WebhookEventType, string> = {
  "incident.triggered":
    "An incident opened: a monitor went down, an alert came in, or someone opened one by hand.",
  "incident.acknowledged": "Someone acknowledged an incident.",
  "incident.resolved": "An incident was resolved, by a person or because the monitor recovered.",
  "incident.reopened": "A resolved incident opened again.",
  "monitor.created": "A monitor was created.",
  "monitor.updated": "A monitor's settings changed.",
  "monitor.deleted": "A monitor was deleted.",
  "monitor.state_changed":
    "A monitor's status changed, for example from up to down. `from` and `to` say how.",
  "status_page.update_published": "An update was published on a status page.",
};

/* What every delivery looks like before a custom template is applied. */
export interface WebhookEnvelope {
  /* Stable for one event at one endpoint, also across retries: use it to drop duplicates. */
  id: string;
  type: WebhookEventType;
  createdAt: string;
  workspaceId: string;
  data: Record<string, unknown>;
}

const SAMPLE_INCIDENT = {
  id: "0199c1a0-5b7e-7c3a-9f41-2d6a8e1b4c70",
  number: 42,
  title: "Checkout API is down",
  status: "triggered",
  severity: "high",
  source: "monitor",
  monitorId: "0199c1a0-4a11-7d52-8c0e-7b9f3e2a1d05",
  causeCode: "http_status_unexpected",
  failingRegions: ["eu-central", "us-east"],
  startedAt: "2026-11-02T09:14:07.000Z",
  acknowledgedAt: null,
  resolvedAt: null,
  durationSeconds: 0,
  url: "https://app.example.com/w/0199c19f-0000-7000-8000-000000000001/incidents/42",
};
const SAMPLE_MONITOR = {
  id: "0199c1a0-4a11-7d52-8c0e-7b9f3e2a1d05",
  name: "Checkout API",
  type: "http",
};

/*
 * One example of `data` per event, with the same fields a real delivery has. The documentation
 * shows them, "Send test" delivers them, and a template is checked against them when it is saved.
 */
export const WEBHOOK_EVENT_SAMPLES: Record<WebhookEventType, Record<string, unknown>> = {
  "incident.triggered": { incident: SAMPLE_INCIDENT, monitor: SAMPLE_MONITOR },
  "incident.acknowledged": {
    incident: {
      ...SAMPLE_INCIDENT,
      status: "acknowledged",
      acknowledgedAt: "2026-11-02T09:16:30.000Z",
      durationSeconds: 143,
    },
    monitor: SAMPLE_MONITOR,
  },
  "incident.resolved": {
    incident: {
      ...SAMPLE_INCIDENT,
      status: "resolved",
      acknowledgedAt: "2026-11-02T09:16:30.000Z",
      resolvedAt: "2026-11-02T09:31:07.000Z",
      durationSeconds: 1_020,
    },
    monitor: SAMPLE_MONITOR,
  },
  "incident.reopened": { incident: SAMPLE_INCIDENT, monitor: SAMPLE_MONITOR },
  "monitor.created": { monitor: SAMPLE_MONITOR },
  "monitor.updated": { monitor: SAMPLE_MONITOR },
  "monitor.deleted": { monitor: { id: SAMPLE_MONITOR.id } },
  "monitor.state_changed": {
    monitor: SAMPLE_MONITOR,
    from: "up",
    to: "down",
    at: "2026-11-02T09:14:07.000Z",
  },
  "status_page.update_published": {
    statusPageId: "0199c1a0-6c00-7a10-8e22-4f5a6b7c8d90",
    statusIncidentId: "0199c1a0-6c11-7b20-9d33-1a2b3c4d5e6f",
    updateId: "0199c1a0-6c22-7c30-8f44-9e8d7c6b5a40",
  },
};

export function sampleWebhookEnvelope(type: WebhookEventType): WebhookEnvelope {
  return {
    id: "0199c1a0-7d00-7e40-8a55-0f1e2d3c4b5a",
    type,
    createdAt: "2026-11-02T09:14:08.000Z",
    workspaceId: "0199c19f-0000-7000-8000-000000000001",
    data: WEBHOOK_EVENT_SAMPLES[type],
  };
}

/* ---- Custom body templates ---- */

function lookup(source: unknown, path: string): unknown {
  let value: unknown = source;
  for (const key of path.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

const PLACEHOLDER = /\{\{\s*(json\s+)?([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\s*\}\}/g;

/*
 * Fills a template from an event. `{{data.incident.title}}` is replaced by the value, escaped so it
 * is safe inside a JSON string (write it between quotes); `{{json data.incident}}` is replaced by
 * the value as JSON (write it without quotes). A path that doesn't exist becomes an empty string,
 * or `null` with `json`. Nothing in a template is run: it is text with holes.
 */
export function renderWebhookTemplate(template: string, envelope: WebhookEnvelope): string {
  return template.replace(PLACEHOLDER, (_match, asJson: string | undefined, path: string) => {
    const value = lookup(envelope, path);
    if (asJson !== undefined) return JSON.stringify(value ?? null);
    if (value === undefined || value === null) return "";
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return JSON.stringify(text).slice(1, -1);
  });
}

/*
 * Why a template can't be used, or undefined when it can: filled in with the example of each event
 * it would be used for, it has to be valid JSON.
 */
export function webhookTemplateProblem(
  template: string,
  events: readonly string[],
): string | undefined {
  for (const type of WEBHOOK_EVENT_TYPES) {
    if (!webhookEventMatches(events, type)) continue;
    try {
      JSON.parse(renderWebhookTemplate(template, sampleWebhookEnvelope(type)));
    } catch {
      return `The template doesn't produce valid JSON for ${type}. Put text placeholders inside quotes, and use {{json …}} for objects, numbers and lists.`;
    }
  }
  return undefined;
}

const eventPattern = z.enum([...WEBHOOK_EVENT_GROUPS, ...WEBHOOK_EVENT_TYPES]);

const endpointFields = {
  name: z.string().trim().min(1).max(80),
  url: z
    .url()
    .max(2_048)
    .refine((u) => /^https:\/\//.test(u), "must be an https URL"),
  events: z
    .array(eventPattern)
    .min(1)
    .transform((list) => [...new Set(list)]),
  /* Null sends the standard envelope. */
  bodyTemplate: z.string().trim().min(2).max(WEBHOOK_TEMPLATE_MAX).nullable(),
  /* Sent with every request; values are write-only. */
  headers: webhookHeadersSchema,
  enabled: z.boolean(),
};

export const createWebhookSchema = z
  .object({
    ...endpointFields,
    bodyTemplate: endpointFields.bodyTemplate.default(null),
    headers: endpointFields.headers.optional(),
    enabled: endpointFields.enabled.default(true),
  })
  .strict();
export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;

/* Only what is sent changes. Sending `headers` replaces them all. */
export const updateWebhookSchema = z
  .object(endpointFields)
  .partial()
  .strict()
  .refine((w) => Object.keys(w).length > 0, "nothing to update");
export type UpdateWebhookInput = z.infer<typeof updateWebhookSchema>;

export interface WebhookEndpointView {
  id: string;
  name: string;
  url: string;
  events: WebhookEventPattern[];
  bodyTemplate: string | null;
  /* The names of the custom headers; their values are never returned. */
  headerNames: string[];
  enabled: boolean;
  /* Why we switched it off, when we did. */
  disabledReason: string | null;
  consecutiveFailures: number;
  lastDeliveryAt: string | null;
  createdAt: string;
}

/* The answer to creating an endpoint or rotating its secret: the only time the secret is shown. */
export interface WebhookEndpointWithSecret extends WebhookEndpointView {
  secret: string;
}

export const WEBHOOK_DELIVERY_STATUSES = ["pending", "delivered", "failed"] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

export interface WebhookDeliveryView {
  id: string;
  eventType: WebhookEventType;
  status: WebhookDeliveryStatus;
  attempts: number;
  /* The HTTP status of the last attempt, or null when no answer came. */
  responseStatus: number | null;
  /* Why the last attempt failed, in plain words. */
  error: string | null;
  createdAt: string;
  deliveredAt: string | null;
  nextAttemptAt: string | null;
  /* True for a test event or a replay started by a person. */
  manual: boolean;
}

export interface WebhookEventInfo {
  type: WebhookEventType;
  description: string;
  sample: WebhookEnvelope;
}

export const webhookCatalog = (): WebhookEventInfo[] =>
  WEBHOOK_EVENT_TYPES.map((type) => ({
    type,
    description: WEBHOOK_EVENT_DESCRIPTIONS[type],
    sample: sampleWebhookEnvelope(type),
  }));
