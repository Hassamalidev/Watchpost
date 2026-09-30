/*
 * Transactional email (PRODUCT.md §7.5 "email.requested → infra/email").
 * Producers emit `email.requested` through the outbox; the `emails` queue handler renders and sends.
 */
import type { DbOrTx } from "../db/index.js";
import type { Logger } from "../logger.js";
import { defineEventProcessor, type Outbox } from "../outbox/index.js";
import type { JobProcessor } from "../queues/index.js";
import { UnrecoverableError } from "bullmq";
import { renderEmail, type EmailTemplate } from "./templates/index.js";
import { PermanentEmailError, type EmailTransport } from "./transport.js";
import type { Db } from "../db/index.js";

export {
  EMAIL_TEMPLATES,
  isEmailTemplate,
  renderEmail,
  type EmailTemplate,
  type RenderedEmail,
} from "./templates/index.js";
export { PALETTE } from "./templates/layout.js";
export {
  PermanentEmailError,
  RESEND_API,
  createConsoleTransport,
  createMemoryTransport,
  createResendTransport,
  type EmailMessage,
  type EmailTransport,
} from "./transport.js";

/* Emits email.requested in its own transaction (for callers outside our transactions, like Better Auth). */
export function createEmailRequester(deps: { db: Db; outbox: Outbox }) {
  return async function requestEmail(
    template: EmailTemplate,
    to: string,
    data: Record<string, unknown>,
    options: {
      workspaceId?: string;
      idempotencyKey?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<void> {
    const { idempotencyKey, headers, ...meta } = options;
    await deps.db.transaction((tx) =>
      deps.outbox.emit(
        tx,
        "email.requested",
        {
          template,
          to,
          data,
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          ...(headers === undefined ? {} : { headers }),
        },
        meta,
      ),
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
        const { subject, text, html } = await renderEmail(payload.template, payload.data);
        let providerRef: string;
        try {
          ({ providerRef } = await deps.transport.send(
            {
              to: payload.to,
              subject,
              text,
              html,
              ...(payload.headers ? { headers: payload.headers } : {}),
              idempotencyKey: payload.idempotencyKey ?? meta.eventId,
            },
            deps.from,
          ));
        } catch (err) {
          if (err instanceof PermanentEmailError) throw new UnrecoverableError(err.message);
          throw err;
        }
        meta.logger.info({ template: payload.template, providerRef }, "email sent");
      },
    },
  });
}
