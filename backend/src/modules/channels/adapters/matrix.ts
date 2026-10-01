/*
 * Matrix (PRODUCT.md §10): a bot account posts to a room through the client-server API. The delivery's
 * idempotency key is the transaction ID, so a retried send can't post twice (the homeserver returns
 * the first event). Follow-ups are thread replies under the incident's first message.
 */
import { matrixChannelConfigSchema, type MatrixChannelConfig } from "@app/shared";
import type { OutboundHttp } from "../../../infra/http/outbound.js";
import {
  ChannelDeliveryError,
  type AlertEvent,
  type ChannelAdapter,
  type RenderedMessage,
} from "../types/adapter.js";
import { formConfig } from "./config.js";
import { call, joinUrl, parseJson } from "./http.js";
import { STATE_EMOJI, alertFacts, escapeHtml, explanationLines, renderPlain } from "./render.js";

/* Matrix error codes that retrying can't fix: no access to the room, a dead token, an unknown room. */
const PERMANENT_CODES = new Set([
  "M_FORBIDDEN",
  "M_UNKNOWN_TOKEN",
  "M_MISSING_TOKEN",
  "M_NOT_FOUND",
  "M_TOO_LARGE",
  "M_UNRECOGNIZED",
]);

function html(event: AlertEvent, message: RenderedMessage): string {
  const title = `${STATE_EMOJI[event.kind]} <b>${escapeHtml(message.title)}</b>`;
  if (event.kind === "test") return `${title}<br>${escapeHtml(message.text)}`;
  return [
    title,
    ...alertFacts(event).map((f) => `<b>${f.label}:</b> ${escapeHtml(f.value)}`),
    ...explanationLines(event).map(escapeHtml),
    `<a href="${escapeHtml(event.incident.url)}">Open incident</a>`,
  ].join("<br>");
}

export function createMatrixAdapter(deps: {
  http: OutboundHttp;
}): ChannelAdapter<MatrixChannelConfig> {
  return {
    type: "matrix",
    ...formConfig("matrix", matrixChannelConfigSchema, "Matrix"),
    render(event) {
      const plain = renderPlain(event);
      return {
        ...plain,
        body: {
          msgtype: "m.text",
          body: plain.text,
          format: "org.matrix.custom.html",
          formatted_body: html(event, plain),
        },
      };
    },
    async send(config, message, meta) {
      /* Transaction IDs go in the path; keep them to unreserved characters. */
      const txnId = meta.idempotencyKey.replace(/[^A-Za-z0-9._~-]/g, "-");
      const res = await call(
        deps.http,
        {
          method: "PUT",
          url: joinUrl(
            config.homeserverUrl,
            `/_matrix/client/v3/rooms/${encodeURIComponent(config.roomId)}/send/m.room.message/${txnId}`,
          ),
          headers: {
            authorization: `Bearer ${config.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            ...(message.body as object),
            ...(meta.threadRef
              ? {
                  "m.relates_to": {
                    rel_type: "m.thread",
                    event_id: meta.threadRef,
                    /* Clients without thread support show it as a reply to the first message. */
                    is_falling_back: true,
                    "m.in_reply_to": { event_id: meta.threadRef },
                  },
                }
              : {}),
          }),
        },
        "Matrix",
      );
      const body = parseJson(res.body) as
        { event_id?: string; errcode?: string; error?: string } | undefined;
      if (res.status >= 200 && res.status < 300) {
        return { providerRef: typeof body?.event_id === "string" ? body.event_id : undefined };
      }
      const code = body?.errcode ?? `HTTP ${res.status}`;
      throw new ChannelDeliveryError(
        `Matrix refused the message: ${code}${body?.error ? ` (${body.error})` : ""}`,
        PERMANENT_CODES.has(code) || [401, 403, 404].includes(res.status),
      );
    },
  };
}
