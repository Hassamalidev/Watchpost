/*
 * Pushbullet (PRODUCT.md §6.4, §10): a link push to all of the token owner's devices, or to the
 * subscribers of a Pushbullet channel. The delivery's idempotency key is the push's `guid`, so a
 * retried send can't notify twice.
 */
import { pushbulletChannelConfigSchema, type PushbulletChannelConfig } from "@app/shared";
import type { OutboundHttp } from "../../../infra/http/outbound.js";
import type { AlertEvent, ChannelAdapter } from "../types/adapter.js";
import { formConfig } from "./config.js";
import { parseJson, postJson } from "./http.js";
import { renderPlain } from "./render.js";

export const PUSHBULLET_API = "https://api.pushbullet.com/v2/pushes";
/* A malformed push, a revoked token or an unknown channel tag. */
const PERMANENT = [400, 401, 403, 404];

export function createPushbulletAdapter(deps: {
  http: OutboundHttp;
}): ChannelAdapter<PushbulletChannelConfig> {
  return {
    type: "pushbullet",
    ...formConfig("pushbullet", pushbulletChannelConfigSchema, "Pushbullet"),
    render(event) {
      const plain = renderPlain(event);
      return { ...plain, body: event };
    },
    async send(config, message, meta) {
      const event = message.body as AlertEvent;
      const res = await postJson(deps.http, {
        url: PUSHBULLET_API,
        headers: { "access-token": config.accessToken },
        body: {
          type: "link",
          title: message.title,
          body: message.text,
          url: event.incident.url,
          guid: meta.idempotencyKey,
          ...(config.channelTag ? { channel_tag: config.channelTag } : {}),
        },
        label: "Pushbullet",
        permanentStatuses: PERMANENT,
      });
      const iden = (parseJson(res.body) as { iden?: unknown } | undefined)?.iden;
      return { providerRef: typeof iden === "string" ? iden : undefined };
    },
  };
}
