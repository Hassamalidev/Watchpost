/*
 * The contract every channel implements (PRODUCT.md §9.4). Adapters are pure translators: parse the
 * config, render an alert event into the provider's message shape, send it, and optionally update an
 * earlier message or check health. Delivery planning, retries and fallbacks live in `alerting`.
 */
import type { AlertEventKind, ChannelType } from "@app/shared";

export interface AlertEvent {
  kind: AlertEventKind | "test";
  workspace: { id: string; name: string };
  incident: {
    id: string;
    number: number;
    title: string;
    severity: "critical" | "high" | "low";
    status: "triggered" | "acknowledged" | "snoozed" | "resolved";
    causeCode: string | null;
    failingRegions: string[];
    monitorName: string | null;
    startedAt: string;
    resolvedAt: string | null;
    durationSeconds: number;
    /* Link to the incident in the web app. */
    url: string;
  };
  /* Who acted ("Sara"), for acknowledgements and manual resolves. */
  actor: string | null;
  at: string;
}

export interface RenderedMessage {
  /* One line: subjects, notification titles, chat fallbacks. */
  title: string;
  /* Plain-text body. */
  text: string;
  /* Provider-specific payload (Slack blocks, an Adaptive Card …), when the adapter builds one. */
  body?: unknown;
}

export interface SendMeta {
  /* Stable per delivery: a retried job passes the same key, so providers that honour it send once. */
  idempotencyKey: string;
  /* Provider reference of the incident's first message, for threading follow-ups. */
  threadRef: string | null;
}

export interface SendResult {
  /* Provider message ID; stored as the thread root for the incident's first message. */
  providerRef?: string | undefined;
}

/* A failed send. `permanent` skips the remaining retries (a revoked token won't fix itself). */
export class ChannelDeliveryError extends Error {
  constructor(
    message: string,
    readonly permanent = false,
  ) {
    super(message);
    this.name = "ChannelDeliveryError";
  }
}

export interface ChannelAdapter<C = unknown> {
  readonly type: ChannelType;
  /* Throws a ValidationError for a bad config. */
  parseConfig(input: unknown): C;
  /* What the API may show; secrets masked. Defaults to the config itself. */
  redact?(config: C): Record<string, unknown>;
  render(event: AlertEvent): RenderedMessage;
  send(config: C, message: RenderedMessage, meta: SendMeta): Promise<SendResult>;
  update?(config: C, ref: string, message: RenderedMessage): Promise<void>;
  health?(config: C): Promise<{ ok: boolean; error?: string }>;
}

/* Adapters of every config type fit one registry (method parameters are bivariant). */
export type AnyChannelAdapter = ChannelAdapter<unknown>;
