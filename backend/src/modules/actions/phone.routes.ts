/*
 * Requests from the messaging provider (PRODUCT.md §10, §12): an SMS reply and the keypress of a
 * voice alert. Both are form posts signed by the provider; the signature covers the exact URL and
 * every field, and is checked before anything is read. The answer is TwiML.
 */
import express, { Router, type Request } from "express";
import { z } from "zod";
import { UnauthorizedError } from "../../core/errors.js";
import {
  EMPTY_TWIML,
  messageTwiml,
  sayTwiml,
  type MessagingProvider,
} from "../../infra/messaging/index.js";
import type { ActionsService } from "./actions.service.js";

export const TWILIO_SMS_PATH = "/api/webhooks/twilio/sms";
export const TWILIO_VOICE_PATH = "/api/webhooks/twilio/voice";

const phone = z.string().regex(/^\+[1-9]\d{7,14}$/);
const smsBody = z.object({ From: phone, Body: z.string().max(1_600).default("") });
const voiceBody = z.object({ To: phone, Digits: z.string().max(4).default("") });
/* A call is about one incident, or is a test call; a keypress never acts on anything else. */
const voiceQuery = z.union([z.object({ incident: z.uuid() }), z.object({ test: z.literal("1") })]);

export function createPhoneActionsRouter(
  service: ActionsService,
  options: { messaging: MessagingProvider; publicUrl: string },
): Router {
  const router = Router();
  const form = express.urlencoded({ extended: false, limit: "20kb" });

  function fieldsOf(req: Request): Record<string, string> {
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries((req.body ?? {}) as Record<string, unknown>)) {
      if (typeof value === "string") fields[key] = value;
    }
    const signature = req.get("x-twilio-signature") ?? "";
    const url = `${options.publicUrl.replace(/\/+$/, "")}${req.originalUrl}`;
    if (signature === "" || !options.messaging.verifySignature(url, fields, signature)) {
      throw new UnauthorizedError("Invalid provider signature.");
    }
    return fields;
  }

  router.post(TWILIO_SMS_PATH, form, async (req, res) => {
    const fields = smsBody.safeParse(fieldsOf(req));
    res.type("text/xml");
    if (!fields.success) {
      res.send(EMPTY_TWIML);
      return;
    }
    const reply = await service.phoneReply({
      phone: fields.data.From,
      text: fields.data.Body,
      via: "sms",
    });
    res.send(reply === null ? EMPTY_TWIML : messageTwiml(reply));
  });

  router.post(TWILIO_VOICE_PATH, form, async (req, res) => {
    const fields = voiceBody.safeParse(fieldsOf(req));
    const query = voiceQuery.safeParse(req.query);
    res.type("text/xml");
    if (!fields.success || !query.success) {
      res.send(sayTwiml("Sorry, that didn't work. Please use the Watchpost app."));
      return;
    }
    if ("test" in query.data) {
      res.send(sayTwiml("The test worked. Goodbye."));
      return;
    }
    const reply = await service.phoneReply({
      phone: fields.data.To,
      text: fields.data.Digits,
      via: "voice",
      incidentId: query.data.incident,
    });
    res.send(sayTwiml(reply ?? "Goodbye."));
  });
  return router;
}
