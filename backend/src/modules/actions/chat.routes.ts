/*
 * Button presses from chat apps (PRODUCT.md §10, §12).
 * - Slack posts a click on Acknowledge or Resolve to /api/integrations/slack/actions as a form with a
 *   `payload` field. The signature (v0, HMAC-SHA256 of the timestamp and the raw body under the app's
 *   signing secret) is checked before anything is read, and a request older than five minutes is
 *   refused.
 * - Telegram posts every bot update to /api/webhooks/telegram with our secret header. A button tap is
 *   a `callback_query`; anything else (a channel's /start link) goes on to the channels module.
 * Both act only on a message we sent for that incident, and answer within the provider's deadline.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import express, { Router } from "express";
import { z } from "zod";
import type { Clock } from "../../core/clock.js";
import { UnauthorizedError } from "../../core/errors.js";
import type { OutboundHttp } from "../../infra/http/outbound.js";
import type { Logger } from "../../infra/logger.js";
import {
  SLACK_ACK_ACTION,
  SLACK_RESOLVE_ACTION,
  TELEGRAM_ACK,
  TELEGRAM_RESOLVE,
  type IntegrationsService,
} from "../channels/index.js";
import type { ActionsService } from "./actions.service.js";

export const SLACK_ACTIONS_PATH = "/api/integrations/slack/actions";
export const TELEGRAM_WEBHOOK_PATH = "/api/webhooks/telegram";
const SLACK_MAX_AGE_SECONDS = 5 * 60;

export function slackSignature(secret: string, timestamp: string, rawBody: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
}

export function verifySlackRequest(input: {
  secret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  now: Date;
}): boolean {
  const { timestamp, signature } = input;
  if (timestamp === undefined || signature === undefined || !/^\d{1,12}$/.test(timestamp)) {
    return false;
  }
  if (Math.abs(input.now.getTime() / 1_000 - Number(timestamp)) > SLACK_MAX_AGE_SECONDS) {
    return false;
  }
  const expected = Buffer.from(slackSignature(input.secret, timestamp, input.rawBody));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const slackPayload = z.object({
  type: z.literal("block_actions"),
  user: z.object({
    id: z.string().max(64),
    username: z.string().max(200).optional(),
    name: z.string().max(200).optional(),
  }),
  container: z.object({ channel_id: z.string().max(64), message_ts: z.string().max(64) }),
  actions: z
    .array(z.object({ action_id: z.string().max(100), value: z.string().max(100).optional() }))
    .min(1),
  response_url: z.url().optional(),
});

/* Raw-body router mounted at the Slack actions path (before the JSON parser). */
export function createSlackActionsRouter(
  service: ActionsService,
  options: { signingSecret: string; http: OutboundHttp; clock: Clock; logger: Logger },
): Router {
  const router = Router();
  router.post("/", express.raw({ type: () => true, limit: "200kb" }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    if (
      !verifySlackRequest({
        secret: options.signingSecret,
        timestamp: req.get("x-slack-request-timestamp"),
        signature: req.get("x-slack-signature"),
        rawBody,
        now: options.clock.now(),
      })
    ) {
      throw new UnauthorizedError("Invalid Slack signature.");
    }
    let parsed: z.infer<typeof slackPayload> | undefined;
    try {
      const json: unknown = JSON.parse(new URLSearchParams(rawBody).get("payload") ?? "");
      const result = slackPayload.safeParse(json);
      if (result.success) parsed = result.data;
    } catch {
      parsed = undefined;
    }
    const pressed = parsed?.actions.find(
      (a) => a.action_id === SLACK_ACK_ACTION || a.action_id === SLACK_RESOLVE_ACTION,
    );
    /* Slack wants 200 within three seconds whatever happened; other clicks (a link button) too. */
    if (
      parsed === undefined ||
      pressed === undefined ||
      !z.uuid().safeParse(pressed.value).success
    ) {
      res.status(200).end();
      return;
    }
    const outcome = await service.chatAction({
      provider: "slack",
      providerRef: `${parsed.container.channel_id}:${parsed.container.message_ts}`,
      incidentId: pressed.value as string,
      action: pressed.action_id === SLACK_ACK_ACTION ? "acknowledge" : "resolve",
      externalUserId: parsed.user.id,
      actorName: parsed.user.name ?? parsed.user.username ?? null,
    });
    res.status(200).end();
    /* Tell only the person who clicked what happened; the message itself updates for everyone. */
    if (parsed.response_url !== undefined) {
      try {
        await options.http.request({
          method: "POST",
          url: parsed.response_url,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            response_type: "ephemeral",
            replace_original: false,
            text: outcome.text,
          }),
        });
      } catch (err) {
        options.logger.warn({ err }, "slack action reply failed");
      }
    }
  });
  return router;
}

const telegramCallback = z.object({
  callback_query: z.object({
    id: z.string().max(100),
    data: z.string().max(64).optional(),
    from: z.object({
      id: z.union([z.number(), z.string()]),
      first_name: z.string().max(200).optional(),
      username: z.string().max(200).optional(),
    }),
    message: z
      .object({
        message_id: z.number().int(),
        chat: z.object({ id: z.union([z.number(), z.string()]) }),
      })
      .optional(),
  }),
});

/* JSON router: Telegram bot updates (button taps here, everything else to the channels module). */
export function createTelegramWebhookRouter(
  service: ActionsService,
  options: {
    secret: string | undefined;
    integrations: Pick<IntegrationsService, "telegramUpdate" | "telegramAnswer">;
  },
): Router {
  const router = Router();
  router.post(TELEGRAM_WEBHOOK_PATH, async (req, res) => {
    const expected = options.secret;
    const given = req.get("x-telegram-bot-api-secret-token") ?? "";
    if (
      expected === undefined ||
      given.length !== expected.length ||
      !timingSafeEqual(Buffer.from(given), Buffer.from(expected))
    ) {
      throw new UnauthorizedError("Invalid Telegram secret token.");
    }
    const tap = telegramCallback.safeParse(req.body);
    if (!tap.success) {
      await options.integrations.telegramUpdate(req.body);
      /* Always 200 once authenticated: Telegram retries anything else forever. */
      res.json({ ok: true });
      return;
    }
    const query = tap.data.callback_query;
    const [code, incidentId] = (query.data ?? "").split(":");
    const action =
      code === TELEGRAM_ACK ? "acknowledge" : code === TELEGRAM_RESOLVE ? "resolve" : undefined;
    let text = "This button no longer works. Open the incident in Watchpost.";
    if (
      action !== undefined &&
      query.message !== undefined &&
      z.uuid().safeParse(incidentId).success
    ) {
      const outcome = await service.chatAction({
        provider: "telegram",
        providerRef: `${query.message.chat.id}:${query.message.message_id}`,
        incidentId: incidentId as string,
        action,
        externalUserId: String(query.from.id),
        actorName: query.from.first_name ?? query.from.username ?? null,
      });
      text = outcome.text;
    }
    await options.integrations.telegramAnswer(query.id, text);
    res.json({ ok: true });
  });
  return router;
}
