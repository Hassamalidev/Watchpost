/*
 * Email transports (PRODUCT.md §10). `console` logs in development, `memory` captures in tests.
 * Resend (production) and React Email templates arrive in P1-T18.
 */
import type { Logger } from "../logger.js";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /* Stable per logical email, so a retried job never sends twice (provider idempotency key). */
  idempotencyKey: string;
}

export interface EmailTransport {
  readonly name: string;
  send(message: EmailMessage, from: string): Promise<{ providerRef: string }>;
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
