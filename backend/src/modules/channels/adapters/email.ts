/*
 * Email channel (§6.4): alert emails go through the transactional email pipeline (outbox →
 * `emails` queue → transport). One email per recipient, each with a stable idempotency key, so a
 * retried delivery never sends twice.
 */
import { emailChannelConfigSchema, type EmailChannelConfig } from "@app/shared";
import { ValidationError } from "../../../core/errors.js";
import type { RequestEmail } from "../../../infra/email/index.js";
import type { ChannelAdapter } from "../types/adapter.js";
import { renderPlain } from "./render.js";

export function createEmailAdapter(deps: {
  requestEmail: RequestEmail;
}): ChannelAdapter<EmailChannelConfig> {
  return {
    type: "email",
    parseConfig(input) {
      const parsed = emailChannelConfigSchema.safeParse(input);
      if (!parsed.success)
        throw new ValidationError(`Invalid email channel: ${parsed.error.message}`);
      return parsed.data;
    },
    render: renderPlain,
    async send(config, message, meta) {
      for (const to of config.to) {
        await deps.requestEmail(
          "alert",
          to,
          { subject: message.title, text: message.text },
          { idempotencyKey: `${meta.idempotencyKey}:${to}` },
        );
      }
      return { providerRef: `email:${meta.idempotencyKey}` };
    },
  };
}
