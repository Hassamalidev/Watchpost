/* Public API of the inbound module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { RequestHandler } from "express";
import type { AppModule, Infra } from "../../composition/types.js";
import { newId } from "../../infra/ids.js";
import type { IncidentsService } from "../incidents/index.js";
import { createInboundRepository } from "./inbound.repository.js";
import { createInboundIngestRouter, createInboundRouter } from "./inbound.routes.js";
import { createInboundService, type InboundService } from "./inbound.service.js";

export type { InboundService } from "./inbound.service.js";
export { parseInbound } from "./parsers.js";

export interface InboundModuleDeps {
  infra: Pick<Infra, "db" | "clock" | "config" | "redis">;
  incidents: IncidentsService;
  guards: { session: RequestHandler; workspace: RequestHandler };
}

export interface InboundModule extends AppModule {
  service: InboundService;
}

export function createInboundModule(deps: InboundModuleDeps): InboundModule {
  const { infra } = deps;
  const service = createInboundService({
    db: infra.db,
    repository: createInboundRepository(),
    incidents: deps.incidents,
    clock: infra.clock,
    newId,
    publicOrigin: infra.config.webOrigin,
  });
  return {
    name: "inbound",
    service,
    routers: [{ path: "/api/w/:workspaceId", router: createInboundRouter(service, deps.guards) }],
    rawBodyRouters: [
      { path: "/api/inbound", router: createInboundIngestRouter(service, infra.redis) },
    ],
  };
}
