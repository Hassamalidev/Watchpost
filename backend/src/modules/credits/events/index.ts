/* Handlers for events the credits module consumes (the `credits-events` queue, §7.5). */
import { UnrecoverableError } from "bullmq";
import type { EventHandlers, EventMeta } from "../../../infra/outbox/index.js";
import type { CreditsService } from "../credits.service.js";

function workspaceOf(meta: EventMeta): string {
  if (meta.workspaceId === null) throw new UnrecoverableError("billing event without a workspace");
  return meta.workspaceId;
}

export function createCreditsEventHandlers(
  service: Pick<CreditsService, "grantDue" | "addPurchased">,
): EventHandlers {
  return {
    /* A billing period was paid for: grant the month's credits and fund the provider budgets. */
    "billing.period_renewed": async (_payload, meta) => {
      const granted = await service.grantDue(workspaceOf(meta));
      meta.logger.info({ granted }, "monthly credits granted");
    },
    /* An upgrade inside a paid month tops the allowance up; anything else changes nothing. */
    "billing.plan_changed": async (_payload, meta) => {
      await service.grantDue(workspaceOf(meta));
    },
    "billing.credits_purchased": async ({ transactionId, credits }, meta) => {
      const added = await service.addPurchased(workspaceOf(meta), transactionId, credits);
      meta.logger.info({ transactionId, credits, added }, "credit pack applied");
    },
  };
}
