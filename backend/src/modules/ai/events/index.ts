/* Handlers for events the ai module consumes (the `ai-events` queue, §7.5). */
import type { EventHandlers } from "../../../infra/outbox/index.js";
import type { AiService } from "../ai.service.js";

export function createAiEventHandlers(service: AiService): EventHandlers {
  return {
    /*
     * The incident explainer. This handler has its own queue: the alert is planned by alerting's
     * handler of the same event and never waits for this one (§9.10).
     */
    "incident.triggered": async ({ incidentId }, meta) => {
      const outcome = await service.explainIncident(incidentId);
      meta.logger.info({ incidentId, outcome }, "incident explainer finished");
    },
  };
}
