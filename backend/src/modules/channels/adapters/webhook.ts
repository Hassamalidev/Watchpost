/*
 * Outbound webhook (PRODUCT.md §10): a JSON envelope `{ id, type, createdAt, workspace, incident,
 * monitor }` signed with `Watchpost-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`.
 * `Watchpost-Event-Id` is stable across retries so receivers can deduplicate. Retries run for about an
 * hour (9 attempts); only 410 Gone stops them early.
 *
 * Custom headers (an Authorization header for Zapier, n8n or an internal endpoint) are write-only:
 * the API shows their names with masked values, and a masked value sent back keeps the stored one
 * while the URL stays the same.
 */
import { createHmac, randomBytes } from "node:crypto";
import { SECRET_MASK, webhookChannelConfigSchema } from "@app/shared";
import type { Clock } from "../../../core/clock.js";
import { ValidationError } from "../../../core/errors.js";
import type { OutboundHttp } from "../../../infra/http/outbound.js";
import type { ChannelAdapter } from "../types/adapter.js";
import { parseConfigWith } from "./config.js";
import { call, expectOk } from "./http.js";
import { renderPlain } from "./render.js";

export interface StoredWebhookConfig {
  url: string;
  secret: string;
  headers?: Record<string, string> | undefined;
}

export function signWebhook(secret: string, timestamp: number, body: string): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

const newSecret = () => `whsec_${randomBytes(24).toString("base64url")}`;
const parse = (input: unknown) => parseConfigWith(webhookChannelConfigSchema, input, "Webhook");

/* Replaces masked header values with the stored ones (matched by name, whatever its case). */
function restoreHeaders(
  headers: Record<string, string> | undefined,
  url: string,
  previous: Partial<StoredWebhookConfig>,
): Record<string, string> | undefined {
  if (headers === undefined || Object.keys(headers).length === 0) return undefined;
  const stored = new Map(
    Object.entries(previous.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
  );
  /* The whole URL: on a shared host (Zapier, Make) the path is what tells receivers apart. */
  const sameOrigin = previous.url === url;
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => {
      if (value !== SECRET_MASK) return [name, value];
      const kept = stored.get(name.toLowerCase());
      if (kept === undefined || !sameOrigin) {
        throw new ValidationError(`Webhook: enter the value of the ${name} header again.`, [
          {
            path: "body.config.headers",
            message: sameOrigin
              ? `Enter a value for ${name}.`
              : `Enter the value of ${name} again: the URL changed.`,
          },
        ]);
      }
      return [name, kept];
    }),
  );
}

export function createWebhookAdapter(deps: {
  http: OutboundHttp;
  clock: Clock;
}): ChannelAdapter<StoredWebhookConfig> {
  return {
    type: "webhook",
    retry: { attempts: 9, backoffMs: 15_000 },
    parseConfig(input) {
      const config = parse(input);
      if (config.secret === undefined) throw new ValidationError("The webhook secret is missing.");
      return { url: config.url, secret: config.secret, headers: config.headers };
    },
    async prepare(input, ctx) {
      const config = parse(input);
      const previous = (ctx.previous ?? {}) as Partial<StoredWebhookConfig>;
      const headers = restoreHeaders(config.headers, config.url, previous);
      return {
        url: config.url,
        secret: config.secret ?? previous.secret ?? newSecret(),
        ...(headers === undefined ? {} : { headers }),
      };
    },
    /* Admins see the signing secret (they need it to verify signatures), never header values. */
    redact(config) {
      return {
        url: config.url,
        secret: config.secret,
        ...(config.headers === undefined
          ? {}
          : {
              headers: Object.fromEntries(
                Object.keys(config.headers).map((name) => [name, SECRET_MASK]),
              ),
            }),
      };
    },
    render(event) {
      const plain = renderPlain(event);
      return {
        ...plain,
        body: {
          type: `incident.${event.kind}`,
          createdAt: event.at,
          workspace: event.workspace,
          incident: {
            id: event.incident.id,
            number: event.incident.number,
            title: event.incident.title,
            severity: event.incident.severity,
            status: event.incident.status,
            causeCode: event.incident.causeCode,
            failingRegions: event.incident.failingRegions,
            startedAt: event.incident.startedAt,
            resolvedAt: event.incident.resolvedAt,
            durationSeconds: event.incident.durationSeconds,
            url: event.incident.url,
          },
          monitor:
            event.incident.monitorName === null ? null : { name: event.incident.monitorName },
          actor: event.actor,
          explanation: event.explanation,
        },
      };
    },
    async send(config, message, meta) {
      const body = JSON.stringify({ id: meta.idempotencyKey, ...(message.body as object) });
      const timestamp = Math.floor(deps.clock.now().getTime() / 1_000);
      const res = await call(
        deps.http,
        {
          method: "POST",
          url: config.url,
          headers: {
            /* Ours come last, so a custom header can never replace the signature. */
            ...config.headers,
            "content-type": "application/json",
            "watchpost-event-id": meta.idempotencyKey,
            "watchpost-signature": signWebhook(config.secret, timestamp, body),
          },
          body,
        },
        "The webhook",
      );
      expectOk(res, "The webhook", [410]);
      return { providerRef: `webhook:${meta.idempotencyKey}` };
    },
  };
}
