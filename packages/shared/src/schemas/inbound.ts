/*
 * Inbound alerts (PRODUCT.md §6.8): other tools post their alerts to a token URL and we open and
 * close incidents for them. Every source is parsed into the same small event shape.
 */
import { z } from "zod";
import { SEVERITIES, type Severity } from "../constants/regions.js";

export const INBOUND_KINDS = ["generic", "alertmanager", "grafana", "datadog", "email"] as const;
export type InboundKind = (typeof INBOUND_KINDS)[number];

export const INBOUND_KIND_LABELS: Record<InboundKind, string> = {
  generic: "Generic JSON",
  alertmanager: "Prometheus Alertmanager",
  grafana: "Grafana alerting",
  datadog: "Datadog",
  email: "Email",
};

/* The most alerts one request may carry (Alertmanager groups them). */
export const MAX_INBOUND_EVENTS = 50;

export const createInboundSourceSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(INBOUND_KINDS),
});
export type CreateInboundSourceInput = z.infer<typeof createInboundSourceSchema>;

export const testInboundPayloadSchema = z.object({ payload: z.unknown() });

/* What every source's payload is turned into. */
export interface InboundEvent {
  status: "trigger" | "resolve";
  /* Alerts with the same key are one incident: a second trigger adds nothing, a resolve closes it. */
  key: string;
  title: string;
  severity: Severity;
  description: string | null;
  link: string | null;
}

export interface InboundSourceView {
  id: string;
  name: string;
  kind: InboundKind;
  /* The first characters of the token, to tell sources apart; the full URL is shown only once. */
  tokenHint: string;
  lastReceivedAt: string | null;
  createdAt: string;
}

export interface InboundResult {
  received: number;
  opened: number;
  resolved: number;
  /* Triggers for an incident that is already open, and resolves with nothing open. */
  ignored: number;
}

/* The body of our generic endpoint. */
export const genericInboundSchema = z.object({
  status: z.enum(["trigger", "resolve"]).default("trigger"),
  title: z.string().trim().min(1).max(200),
  dedup_key: z.string().trim().min(1).max(200).optional(),
  severity: z.enum(SEVERITIES).default("high"),
  description: z.string().max(10_000).optional(),
  links: z
    .array(z.object({ href: z.url(), text: z.string().max(200).optional() }))
    .max(10)
    .optional(),
  tags: z.array(z.string().max(60)).max(20).optional(),
});

/* What to paste into Datadog's webhook integration as the payload. */
export const DATADOG_PAYLOAD_TEMPLATE = `{
  "alert_id": "$ALERT_ID",
  "aggreg_key": "$AGGREG_KEY",
  "transition": "$ALERT_TRANSITION",
  "title": "$EVENT_TITLE",
  "priority": "$ALERT_PRIORITY",
  "body": "$TEXT_ONLY_MSG",
  "link": "$LINK"
}`;

/* A firing and a resolved payload per source: for the tester, the docs and the tests. */
export const INBOUND_SAMPLES: Record<InboundKind, { trigger: unknown; resolve: unknown }> = {
  generic: {
    trigger: {
      status: "trigger",
      dedup_key: "db-replica-lag",
      severity: "critical",
      title: "Replica lag above 60 s on db-2",
      description: "Replication is 94 s behind the primary.",
      links: [{ href: "https://grafana.example.com/d/replication", text: "Dashboard" }],
    },
    resolve: {
      status: "resolve",
      dedup_key: "db-replica-lag",
      title: "Replica lag back to normal",
    },
  },
  alertmanager: {
    trigger: {
      version: "4",
      status: "firing",
      receiver: "watchpost",
      alerts: [
        {
          status: "firing",
          labels: { alertname: "HighErrorRate", severity: "critical", instance: "api-1:9090" },
          annotations: {
            summary: "5xx rate above 5% on api-1",
            description: "Error rate is 7.2%.",
          },
          startsAt: "2026-10-06T12:00:00Z",
          endsAt: "0001-01-01T00:00:00Z",
          generatorURL: "https://prometheus.example.com/graph?g0.expr=errors",
          fingerprint: "c5e1a2b3d4f60718",
        },
      ],
    },
    resolve: {
      version: "4",
      status: "resolved",
      receiver: "watchpost",
      alerts: [
        {
          status: "resolved",
          labels: { alertname: "HighErrorRate", severity: "critical", instance: "api-1:9090" },
          annotations: { summary: "5xx rate above 5% on api-1" },
          startsAt: "2026-10-06T12:00:00Z",
          endsAt: "2026-10-06T12:09:00Z",
          fingerprint: "c5e1a2b3d4f60718",
        },
      ],
    },
  },
  grafana: {
    trigger: {
      receiver: "watchpost",
      status: "firing",
      title: "[FIRING:1] DiskAlmostFull (db-1)",
      alerts: [
        {
          status: "firing",
          labels: { alertname: "DiskAlmostFull", instance: "db-1", severity: "warning" },
          annotations: { summary: "Disk on db-1 is 92% full" },
          fingerprint: "9f8e7d6c5b4a3210",
          generatorURL: "https://grafana.example.com/alerting/grafana/abc/view",
        },
      ],
    },
    resolve: {
      receiver: "watchpost",
      status: "resolved",
      title: "[RESOLVED] DiskAlmostFull (db-1)",
      alerts: [
        {
          status: "resolved",
          labels: { alertname: "DiskAlmostFull", instance: "db-1", severity: "warning" },
          annotations: { summary: "Disk on db-1 is 92% full" },
          fingerprint: "9f8e7d6c5b4a3210",
        },
      ],
    },
  },
  datadog: {
    trigger: {
      alert_id: "1234567",
      aggreg_key: "host:web-3",
      transition: "Triggered",
      title: "[Triggered] CPU above 95% on web-3",
      priority: "P2",
      body: "CPU has been above 95% for 10 minutes.",
      link: "https://app.datadoghq.com/monitors/1234567",
    },
    resolve: {
      alert_id: "1234567",
      aggreg_key: "host:web-3",
      transition: "Recovered",
      title: "[Recovered] CPU above 95% on web-3",
      priority: "P2",
      link: "https://app.datadoghq.com/monitors/1234567",
    },
  },
  email: {
    trigger: {
      from: "nagios@example.com",
      subject: "PROBLEM: web-1 HTTP is CRITICAL",
      text: "HTTP CRITICAL - connection refused",
    },
    resolve: {
      from: "nagios@example.com",
      subject: "RECOVERY: web-1 HTTP is OK",
      text: "HTTP OK - 200 in 0.2 s",
    },
  },
};
