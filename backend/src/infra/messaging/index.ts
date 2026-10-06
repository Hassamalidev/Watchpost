/*
 * SMS and voice (PRODUCT.md §10). `MessagingProvider` is what the product talks to, so Telnyx, Plivo
 * or a local gateway can be added per country later; Twilio is the first implementation.
 *
 * Twilio's REST API (checked against its docs 2026-10-01): form-encoded POSTs with HTTP basic auth
 * to /2010-04-01/Accounts/{sid}/Messages.json and /Calls.json. A call takes its instructions inline
 * (`Twiml`), so nothing has to be fetched from us before the phone rings. Requests Twilio sends to
 * us carry `X-Twilio-Signature`: base64(HMAC-SHA1(auth token, URL + every POST field sorted by name,
 * name and value appended)).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { OutboundError, type OutboundHttp } from "../http/outbound.js";

export class MessagingError extends Error {
  constructor(
    message: string,
    /* Retrying can't help: an invalid or unreachable number, a blocked destination. */
    readonly permanent = false,
  ) {
    super(message);
    this.name = "MessagingError";
  }
}

export interface MessagingProvider {
  readonly name: "twilio";
  /* Whether this server can place voice calls (it needs a caller number). */
  readonly canCall: boolean;
  sendSms(input: { to: string; body: string }): Promise<{ ref: string }>;
  /* Speaks `say`, waits for one keypress and posts it to `gatherUrl`. */
  call(input: { to: string; say: string; gatherUrl: string }): Promise<{ ref: string }>;
  /* True if `signature` is the provider's signature for a POST of `params` to `url`. */
  verifySignature(url: string, params: Record<string, string>, signature: string): boolean;
}

export interface TwilioOptions {
  accountSid: string;
  authToken: string;
  /* Either a Messaging Service (recommended: sender pools, compliance) or one sender number. */
  messagingServiceSid?: string | undefined;
  smsFrom?: string | undefined;
  voiceFrom?: string | undefined;
}

export const TWILIO_API = "https://api.twilio.com/2010-04-01";

/* Twilio error codes that mean the number itself is the problem (docs: /docs/api/errors). */
const PERMANENT_CODES = new Set([
  21211, 21214, 21217, 21219, 21401, 21407, 21408, 21610, 21612, 21614, 21215, 21216, 13224,
]);

export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

const escapeXml = (text: string) =>
  text.replace(
    /[<>&'"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] ?? c,
  );

/* Says the message, waits for one digit, and repeats once if nothing is pressed. */
export function gatherTwiml(say: string, gatherUrl: string): string {
  const gather = `<Gather numDigits="1" timeout="8" action="${escapeXml(gatherUrl)}" method="POST"><Say>${escapeXml(say)}</Say></Gather>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${gather}${gather}<Say>Goodbye.</Say></Response>`;
}

export const sayTwiml = (say: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(say)}</Say></Response>`;

/* An empty reply: Twilio sends no SMS back. */
export const EMPTY_TWIML = `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;

export const messageTwiml = (text: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(text)}</Message></Response>`;

export function createTwilioProvider(
  options: TwilioOptions & { http: OutboundHttp },
): MessagingProvider {
  const authorization = `Basic ${Buffer.from(`${options.accountSid}:${options.authToken}`).toString("base64")}`;
  const account = `${TWILIO_API}/Accounts/${encodeURIComponent(options.accountSid)}`;

  async function post(path: string, fields: Record<string, string>): Promise<{ ref: string }> {
    let res;
    try {
      res = await options.http.request({
        method: "POST",
        url: `${account}${path}`,
        headers: { authorization, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
        maxBodyBytes: 64 * 1024,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new MessagingError(
        `Twilio: ${message}`,
        err instanceof OutboundError && err.code === "blocked",
      );
    }
    let body: { sid?: string; code?: number; message?: string } = {};
    try {
      body = JSON.parse(res.body) as typeof body;
    } catch {
      /* A non-JSON answer is reported by its status below. */
    }
    if (res.status >= 200 && res.status < 300 && typeof body.sid === "string") {
      return { ref: body.sid };
    }
    const reason = body.message ?? `HTTP ${res.status}`;
    /* 401 and 403 are our credentials or account, never the customer's number: keep retrying. */
    const permanent = body.code !== undefined && PERMANENT_CODES.has(body.code);
    throw new MessagingError(`Twilio refused the request: ${reason}`, permanent);
  }

  return {
    name: "twilio",
    canCall: options.voiceFrom !== undefined,

    sendSms({ to, body }) {
      const sender: Record<string, string> | undefined =
        options.messagingServiceSid !== undefined
          ? { MessagingServiceSid: options.messagingServiceSid }
          : options.smsFrom !== undefined
            ? { From: options.smsFrom }
            : undefined;
      if (sender === undefined) {
        throw new MessagingError("No SMS sender is configured on this server.", true);
      }
      return post("/Messages.json", { To: to, Body: body, ...sender });
    },

    call({ to, say, gatherUrl }) {
      if (options.voiceFrom === undefined) {
        throw new MessagingError("No caller number is configured on this server.", true);
      }
      return post("/Calls.json", {
        To: to,
        From: options.voiceFrom,
        Twiml: gatherTwiml(say, gatherUrl),
        /* Ring for 30 s; a call can't run past a minute, which is what its credits pay for. */
        Timeout: "30",
        TimeLimit: "60",
      });
    },

    verifySignature(url, params, signature) {
      const expected = Buffer.from(twilioSignature(options.authToken, url, params));
      const given = Buffer.from(signature);
      return given.length === expected.length && timingSafeEqual(given, expected);
    },
  };
}
