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
    /* "Failed after 10 s" or "Answered in 412 ms; slowest step: …"; absent when nothing was timed. */
    timing?: string | null | undefined;
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
  /* Plain-language cause and first checks (failure explainer); null when nothing failed. */
  explanation: { headline: string; detail: string; nextSteps: string[] } | null;
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

export interface PrepareContext {
  workspaceId: string;
  /* The stored config when updating a channel. */
  previous: unknown;
}

export interface ChannelAdapter<C = unknown> {
  readonly type: ChannelType;
  /* Retry policy for this channel's deliveries; the default is 5 attempts from 8 s. */
  readonly retry?: { attempts: number; backoffMs: number };
  /* Throws a ValidationError for a bad config. Used for stored configs, so it must be pure. */
  parseConfig(input: unknown): C;
  /*
   * Turns API input into a config to store: validates, fills generated values (secrets) and checks
   * references (a Slack installation belongs to the workspace). Defaults to parseConfig.
   */
  prepare?(input: unknown, ctx: PrepareContext): Promise<C>;
  /* What the API may show; secrets masked. Defaults to the config itself. */
  redact?(config: C): Record<string, unknown>;
  /*
   * Paid channels (SMS, voice): what one message costs. `channels.deliver` charges the credits
   * before sending and meters the provider cost after.
   */
  cost?(config: C): { kind: string; credits: number; costMicros: number };
  /* Events this channel never sends (a call isn't placed to say an incident is over). */
  skip?(event: AlertEvent): boolean;
  render(event: AlertEvent): RenderedMessage;
  send(config: C, message: RenderedMessage, meta: SendMeta): Promise<SendResult>;
  update?(config: C, ref: string, message: RenderedMessage): Promise<void>;
  health?(config: C): Promise<{ ok: boolean; error?: string }>;
}

/* Adapters of every config type fit one registry (method parameters are bivariant). */
export type AnyChannelAdapter = ChannelAdapter<unknown>;
