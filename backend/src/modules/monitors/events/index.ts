/* Handlers for events the monitors module consumes (the `monitors-events` queue, §7.5). */
import { UnrecoverableError } from "bullmq";
import { createWorkspaceScope } from "../../../core/workspace-scope.js";
import type { EventHandlers } from "../../../infra/outbox/index.js";
import type { MonitorsService } from "../monitors.service.js";

export function createMonitorsEventHandlers(
  service: Pick<MonitorsService, "enforcePlanLimits">,
): EventHandlers {
  return {
    /* The plan changed: pause what no longer fits, or resume what a downgrade had paused (§5). */
    "billing.plan_changed": async (payload, meta) => {
      if (meta.workspaceId === null) {
        throw new UnrecoverableError("billing.plan_changed without a workspace");
      }
      const result = await service.enforcePlanLimits(
        createWorkspaceScope({ workspaceId: meta.workspaceId }),
      );
      meta.logger.info({ ...payload, ...result }, "plan limits enforced on monitors");
    },
  };
}
