/*
 * Transactional email (PRODUCT.md §7.5 "email.requested → infra/email").
 * Producers emit `email.requested` through the outbox; the `emails` queue handler renders and sends.
 */
import type { DbOrTx } from "../db/index.js";
import type { Logger } from "../logger.js";
import { defineEventProcessor, type Outbox } from "../outbox/index.js";
import type { JobProcessor } from "../queues/index.js";
import { renderEmail, type EmailTemplate } from "./templates.js";
import type { EmailTransport } from "./transport.js";
import type { Db } from "../db/index.js";

export { EMAIL_TEMPLATES, isEmailTemplate, renderEmail, type EmailTemplate } from "./templates.js";
export {
  createConsoleTransport,
  createMemoryTransport,
  type EmailMessage,
  type EmailTransport,
} from "./transport.js";

/* Emits email.requested in its own transaction (for callers outside our transactions, like Better Auth). */
export function createEmailRequester(deps: { db: Db; outbox: Outbox }) {
  return async function requestEmail(
    template: EmailTemplate,
    to: string,
    data: Record<string, unknown>,
    options: { workspaceId?: string } = {},
  ): Promise<void> {
    await deps.db.transaction((tx) =>
      deps.outbox.emit(tx, "email.requested", { template, to, data }, options),
    );
  };
}

export type RequestEmail = ReturnType<typeof createEmailRequester>;

export function createEmailProcessor(deps: {
  db: DbOrTx;
  transport: EmailTransport;
  from: string;
  logger: Logger;
}): JobProcessor {
  return defineEventProcessor({
    queue: "emails",
    handler: "email",
    db: deps.db,
    handlers: {
      "email.requested": async (payload, meta) => {
        const { subject, text } = renderEmail(payload.template, payload.data);
        const { providerRef } = await deps.transport.send(
          { to: payload.to, subject, text, idempotencyKey: meta.eventId },
          deps.from,
        );
        meta.logger.info({ template: payload.template, providerRef }, "email sent");
      },
    },
  });
}
