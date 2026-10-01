/* Handlers for events the billing module consumes (the `billing-events` queue, §7.5). */
import type { EventHandlers } from "../../../infra/outbox/index.js";
import type { WorkspacesService } from "../../workspaces/index.js";
import { systemScope } from "../../workspaces/index.js";
import type { BillingService } from "../billing.service.js";
import type { TrialService } from "../trial.js";

export function createBillingEventHandlers(deps: {
  service: Pick<BillingService, "ensureAccount">;
  trial: Pick<TrialService, "notify">;
  workspaces: Pick<WorkspacesService, "getSettings">;
}): EventHandlers {
  return {
    /* A new workspace gets its billing account and the trial welcome email. */
    "workspace.created": async ({ workspaceId }) => {
      await deps.service.ensureAccount(workspaceId);
      const settings = await deps.workspaces.getSettings(systemScope(workspaceId));
      if (settings.trialEndsAt !== null) {
        await deps.trial.notify(workspaceId, new Date(settings.trialEndsAt));
      }
    },
  };
}
