/* Handlers for events the ai module consumes (the `ai-events` queue, §7.5). */
import type { EventHandlers } from "../../../infra/outbox/index.js";

export function createAiEventHandlers(): EventHandlers {
  return {
    /* The incident explainer (P5-T02) starts here. */
    "incident.triggered": async () => undefined,
  };
}
