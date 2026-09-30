/*
 * Email transports (PRODUCT.md §10). `console` logs in development, `memory` captures in tests,
 * `resend` sends through Resend's REST API with an idempotency key, so a retried job never sends
 * twice. Provider rejections that retrying can't fix (a bad address) are permanent.
 */
import type { Logger } from "../logger.js";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string | undefined;
  /* Extra headers, for example List-Unsubscribe on digests. */
  headers?: Record<string, string> | undefined;
  /* Stable per logical email, so a retried job never sends twice (provider idempotency key). */
  idempotencyKey: string;
}

export interface EmailTransport {
  readonly name: string;
  send(message: EmailMessage, from: string): Promise<{ providerRef: string }>;
}

/* A send that must not be retried (the provider refused the message itself). */
export class PermanentEmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentEmailError";
  }
}

export function createConsoleTransport(logger: Logger): EmailTransport {
  return {
    name: "console",
    async send(message, from) {
      logger.info(
        { email: { from, to: message.to, subject: message.subject } },
        `email (console transport):\n${message.text}`,
      );
      return { providerRef: `console:${message.idempotencyKey}` };
    },
  };
}

export function createMemoryTransport() {
  const sent: Array<EmailMessage & { from: string }> = [];
  const transport: EmailTransport & { sent: typeof sent } = {
    name: "memory",
    sent,
    async send(message, from) {
      if (!sent.some((m) => m.idempotencyKey === message.idempotencyKey))
        sent.push({ ...message, from });
      return { providerRef: `memory:${message.idempotencyKey}` };
    },
  };
  return transport;
}

export const RESEND_API = "https://api.resend.com/emails";

export function createResendTransport(options: {
  apiKey: string;
  fetch?: typeof fetch;
}): EmailTransport {
  const doFetch = options.fetch ?? fetch;
  return {
    name: "resend",
    async send(message, from) {
      const res = await doFetch(RESEND_API, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
          /* Resend keeps idempotency keys for 24 h; ours are stable per logical email. */
          "idempotency-key": message.idempotencyKey.slice(0, 256),
        },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          ...(message.html ? { html: message.html } : {}),
          ...(message.headers ? { headers: message.headers } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (res.ok && typeof body.id === "string") return { providerRef: `resend:${body.id}` };
      const detail = `Resend answered HTTP ${res.status}${body.message ? `: ${body.message}` : ""}`;
      /* 4xx other than rate limits and conflicts (an idempotent replay in flight) won't succeed later. */
      if (res.status >= 400 && res.status < 500 && ![409, 429].includes(res.status)) {
        throw new PermanentEmailError(detail);
      }
      throw new Error(detail);
    },
  };
}
