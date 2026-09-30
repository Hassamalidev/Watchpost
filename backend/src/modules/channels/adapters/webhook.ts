/*
 * Outbound webhook (PRODUCT.md §10): a JSON envelope `{ id, type, createdAt, workspace, incident,
 * monitor }` signed with `Watchpost-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`.
 * `Watchpost-Event-Id` is stable across retries so receivers can deduplicate. Retries run for about an
 * hour (9 attempts); only 410 Gone stops them early.
 */
import { createHmac, randomBytes } from "node:crypto";
import { webhookChannelConfigSchema } from "@app/shared";
import type { Clock } from "../../../core/clock.js";
import { ValidationError } from "../../../core/errors.js";
import type { OutboundHttp } from "../../../infra/http/outbound.js";
import type { ChannelAdapter } from "../types/adapter.js";
import { call, expectOk } from "./http.js";
import { renderPlain } from "./render.js";

export interface StoredWebhookConfig {
  url: string;
  secret: string;
}

export function signWebhook(secret: string, timestamp: number, body: string): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

const newSecret = () => `whsec_${randomBytes(24).toString("base64url")}`;

function parse(input: unknown): { url: string; secret?: string | undefined } {
  const parsed = webhookChannelConfigSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(`Invalid webhook: ${parsed.error.message}`);
  return parsed.data;
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
      return { url: config.url, secret: config.secret };
    },
    async prepare(input, ctx) {
      const config = parse(input);
      const previous = (ctx.previous ?? {}) as Partial<StoredWebhookConfig>;
      return { url: config.url, secret: config.secret ?? previous.secret ?? newSecret() };
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
