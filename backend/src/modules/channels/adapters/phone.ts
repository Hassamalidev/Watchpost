/*
 * SMS and voice (PRODUCT.md §6.4, §10). Both go to one phone number the workspace has verified with a
 * one-time code, and both cost alert credits: `cost` tells `channels.deliver` what to charge before
 * the message is handed to the provider.
 *
 * An SMS fits one segment (160 GSM characters) and ends with the reply codes. A call reads the alert
 * and waits for one keypress: 1 acknowledges. Follow-ups (acknowledged, resolved) are sent as SMS but
 * never as calls: nobody wants the phone to ring to say it's over.
 */
import { phoneChannelConfigSchema, type PhoneChannelConfig } from "@app/shared";
import { ValidationError } from "../../../core/errors.js";
import { rateForPhone } from "../../../config/messaging-rates.js";
import { MessagingError, type MessagingProvider } from "../../../infra/messaging/index.js";
import {
  ChannelDeliveryError,
  type AlertEvent,
  type ChannelAdapter,
  type RenderedMessage,
} from "../types/adapter.js";
import { parseConfigWith } from "./config.js";
import { alertSubject } from "./render.js";

const SMS_SEGMENT = 160;
/* What the GSM 7-bit alphabet can't carry is replaced, so the text stays one segment. */
const toGsm = (text: string) =>
  text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\n\r\x20-\x7e]/g, "?");

const STATE: Record<AlertEvent["kind"], string> = {
  triggered: "DOWN",
  reminder: "STILL DOWN",
  flapping: "UNSTABLE",
  acknowledged: "ACK",
  resolved: "OK",
  test: "TEST",
};

const subject = (event: AlertEvent) => alertSubject(event);

/* `Watchpost: DOWN API Prod (HTTP 502, 3 regions) #482. Reply 1=ack 2=resolve` */
export function smsText(event: AlertEvent): string {
  const { incident } = event;
  if (event.kind === "test") return "Watchpost: test alert. SMS alerts to this number work.";
  const head = `Watchpost: ${STATE[event.kind]} `;
  const open = event.kind === "triggered" || event.kind === "reminder" || event.kind === "flapping";
  const regions = incident.failingRegions.length;
  const why =
    open && event.explanation !== null
      ? ` (${event.explanation.headline}${regions > 1 ? `, ${regions} regions` : ""})`
      : "";
  const who = event.kind === "acknowledged" && event.actor !== null ? ` by ${event.actor}` : "";
  const tail = ` #${incident.number}${who}.${open ? " Reply 1=ack 2=resolve" : ""}`;
  const name = toGsm(subject(event));
  const full = `${head}${name}${toGsm(why)}${toGsm(tail)}`;
  if (full.length <= SMS_SEGMENT) return full;
  /* Drop the cause first, then shorten the name; the number and reply codes always stay. */
  const room = SMS_SEGMENT - head.length - toGsm(tail).length;
  return `${head}${name.length > room ? `${name.slice(0, Math.max(0, room - 3))}...` : name}${toGsm(tail)}`;
}

export function voiceText(event: AlertEvent): string {
  if (event.kind === "test") {
    return "This is a test call from Watchpost. Voice alerts to this number work. Press 1 to end the call.";
  }
  const { incident } = event;
  const cause = event.explanation === null ? "" : ` ${event.explanation.headline}.`;
  return `Watchpost alert. ${subject(event)} ${event.group ? "are" : "is"} ${event.kind === "flapping" ? "unstable" : "down"}.${cause} Incident number ${incident.number}. Press 1 to acknowledge.`;
}

function phoneConfig(label: string) {
  return {
    parseConfig: (input: unknown) => parseConfigWith(phoneChannelConfigSchema, input, label),
  };
}

export interface PhoneAdapterDeps {
  messaging: MessagingProvider;
  /* True when the workspace has confirmed this number with a code. */
  isVerified(workspaceId: string, phone: string): Promise<boolean>;
  /* Where the provider posts the keypress of a call; null for a test call. */
  gatherUrl(incidentId: string | null): string;
}

async function prepared(
  deps: PhoneAdapterDeps,
  label: string,
  input: unknown,
  workspaceId: string,
): Promise<PhoneChannelConfig> {
  const config = parseConfigWith(phoneChannelConfigSchema, input, label);
  const fail = (message: string) =>
    new ValidationError(`${label}: ${message}`, [{ path: "body.config.phone", message }]);
  if (rateForPhone(config.phone) === undefined) {
    throw fail("Numbers in this country aren't supported yet.");
  }
  if (!(await deps.isVerified(workspaceId, config.phone))) {
    throw fail("Verify this number first: send a code to it and enter the code.");
  }
  return config;
}

const rethrow = (err: unknown): never => {
  if (err instanceof MessagingError) throw new ChannelDeliveryError(err.message, err.permanent);
  throw err;
};

/* The rate was checked when the channel was saved; a number that lost its rate can't be sent to. */
function rateOf(config: PhoneChannelConfig) {
  const rate = rateForPhone(config.phone);
  if (rate === undefined) {
    throw new ChannelDeliveryError("Numbers in this country aren't supported any more.", true);
  }
  return rate;
}

export function createSmsAdapter(deps: PhoneAdapterDeps): ChannelAdapter<PhoneChannelConfig> {
  return {
    type: "sms",
    /* A text that arrives an hour late is noise: three tries within about a minute. */
    retry: { attempts: 3, backoffMs: 10_000 },
    ...phoneConfig("SMS"),
    prepare: (input, ctx) => prepared(deps, "SMS", input, ctx.workspaceId),
    cost(config) {
      const rate = rateOf(config);
      return { kind: "sms", credits: rate.smsCredits, costMicros: rate.smsMicros };
    },
    render(event): RenderedMessage {
      const text = smsText(event);
      return { title: text, text };
    },
    async send(config, message) {
      try {
        const { ref } = await deps.messaging.sendSms({ to: config.phone, body: message.text });
        return { providerRef: ref };
      } catch (err) {
        return rethrow(err);
      }
    },
  };
}

export function createVoiceAdapter(deps: PhoneAdapterDeps): ChannelAdapter<PhoneChannelConfig> {
  return {
    type: "voice",
    retry: { attempts: 2, backoffMs: 20_000 },
    ...phoneConfig("Voice call"),
    prepare: (input, ctx) => prepared(deps, "Voice call", input, ctx.workspaceId),
    cost(config) {
      const rate = rateOf(config);
      return { kind: "voice", credits: rate.voiceCredits, costMicros: rate.voiceMinuteMicros };
    },
    skip: (event) => event.kind === "acknowledged" || event.kind === "resolved",
    render(event): RenderedMessage {
      const text = voiceText(event);
      return { title: text, text, body: event.kind === "test" ? null : event.incident.id };
    },
    async send(config, message) {
      try {
        const incidentId = typeof message.body === "string" ? message.body : null;
        const { ref } = await deps.messaging.call({
          to: config.phone,
          say: message.text,
          gatherUrl: deps.gatherUrl(incidentId),
        });
        return { providerRef: ref };
      } catch (err) {
        return rethrow(err);
      }
    },
  };
}
