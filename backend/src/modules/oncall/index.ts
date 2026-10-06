/* Public API of the oncall module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { RequestHandler } from "express";
import type { AppModule, Infra } from "../../composition/types.js";
import { newId } from "../../infra/ids.js";
import type { ContactsService } from "../contacts/index.js";
import type { IncidentsService } from "../incidents/index.js";
import type { WorkspacesService } from "../workspaces/index.js";
import { createOncallController } from "./oncall.controller.js";
import { createOncallRepository } from "./oncall.repository.js";
import { createFeedRouter, createOncallRouter } from "./oncall.routes.js";
import { createOncallService, type OncallService } from "./oncall.service.js";

export type { EscalationPolicyDefinition, OncallService, Shift } from "./oncall.service.js";
export { SHIFT_NOTICE_LOOKBACK_MS } from "./oncall.service.js";

export interface OncallModuleDeps {
  infra: Pick<Infra, "db" | "clock" | "config" | "outbox">;
  workspaces: WorkspacesService;
  /* For shift start and end notices; optional so tests can build schedules without it. */
  contacts?: Pick<ContactsService, "fanOut">;
  /* For the handoff report at shift end. */
  incidents?: Pick<IncidentsService, "shiftReport">;
  guards: { session: RequestHandler; workspace: RequestHandler };
}

export interface OncallModule extends AppModule {
  service: OncallService;
}

export function createOncallModule(deps: OncallModuleDeps): OncallModule {
  const service = createOncallService({
    db: deps.infra.db,
    repository: createOncallRepository(),
    workspaces: deps.workspaces,
    contacts: deps.contacts,
    incidents: deps.incidents,
    outbox: deps.infra.outbox,
    clock: deps.infra.clock,
    newId,
    webOrigin: deps.infra.config.webOrigin,
  });
  return {
    name: "oncall",
    service,
    routers: [
      {
        path: "/api/w/:workspaceId",
        router: createOncallRouter(createOncallController(service), deps.guards),
      },
      { path: "/api/oncall", router: createFeedRouter(service) },
    ],
    /* Shift starts and ends are announced within a minute of happening. */
    sweeps: [
      {
        kind: "oncall-shifts",
        everyMs: 60_000,
        async run(logger) {
          const sent = await service.notifyShifts();
          if (sent > 0) logger.info({ sent }, "shift notices sent");
        },
      },
    ],
  };
}
