/* Public API of the ai module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { RequestHandler } from "express";
import type { AppModule, Infra } from "../../composition/types.js";
import { newId } from "../../infra/ids.js";
import type { CreditsService } from "../credits/index.js";
import type { IncidentsService } from "../incidents/index.js";
import { createAiController } from "./ai.controller.js";
import { createAiRepository } from "./ai.repository.js";
import { createAiRouter } from "./ai.routes.js";
import { createAiService, type AiService } from "./ai.service.js";
import { createAiProcessors } from "./jobs/index.js";

export type { AiService, Generated, GenerateInput } from "./ai.service.js";
export { internalDetailIn, redact, redactText } from "./redact.js";

export interface AiModuleDeps {
  infra: Pick<Infra, "db" | "clock" | "logger" | "ai">;
  credits: Pick<CreditsService, "aiBudget" | "recordUsage">;
  incidents: Pick<IncidentsService, "aiEvidence" | "setAiSummary">;
  guards: { session: RequestHandler; workspace: RequestHandler };
}

export interface AiModule extends AppModule {
  service: AiService;
}

export function createAiModule(deps: AiModuleDeps): AiModule {
  const service = createAiService({
    repository: createAiRepository(deps.infra.db),
    client: deps.infra.ai,
    credits: deps.credits,
    incidents: deps.incidents,
    clock: deps.infra.clock,
    logger: deps.infra.logger,
    newId,
  });
  return {
    name: "ai",
    service,
    routers: [
      {
        path: "/api/w/:workspaceId",
        router: createAiRouter(createAiController(service), deps.guards),
      },
    ],
    processors: createAiProcessors(service, deps.infra.db),
  };
}
