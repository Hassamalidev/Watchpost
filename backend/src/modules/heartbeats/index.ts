/* Public API of the heartbeats module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { RequestHandler } from "express";
import type { AppModule, Infra } from "../../composition/types.js";
import { newId } from "../../infra/ids.js";
import type { IncidentsService } from "../incidents/index.js";
import type { MonitorsService } from "../monitors/index.js";
import { createHeartbeatsRepository } from "./heartbeats.repository.js";
import { createHeartbeatsRouter, createPingRouter } from "./heartbeats.routes.js";
import { createHeartbeatsService, type HeartbeatsService } from "./heartbeats.service.js";

export type {
  HeartbeatView,
  HeartbeatsService,
  PingSignal,
  SweepOutcome,
} from "./heartbeats.service.js";

/* §9.7: misses every 15 s, platform tick every 10 s. */
export const HEARTBEAT_SWEEP_EVERY_MS = 15_000;
export const PLATFORM_TICK_EVERY_MS = 10_000;

export interface HeartbeatsModuleDeps {
  infra: Pick<Infra, "db" | "clock" | "outbox" | "logger" | "config">;
  monitors: MonitorsService;
  incidents: IncidentsService;
  guards: { session: RequestHandler; workspace: RequestHandler };
}

export interface HeartbeatsModule extends AppModule {
  service: HeartbeatsService;
}

export function createHeartbeatsModule(deps: HeartbeatsModuleDeps): HeartbeatsModule {
  const { infra } = deps;
  const service = createHeartbeatsService({
    db: infra.db,
    repository: createHeartbeatsRepository(),
    monitors: deps.monitors,
    incidents: deps.incidents,
    outbox: infra.outbox,
    clock: infra.clock,
    logger: infra.logger.child({ module: "heartbeats" }),
    newId,
    baseUrl: infra.config.heartbeat.baseUrl,
  });
  return {
    name: "heartbeats",
    service,
    routers: [
      { path: "/api/w/:workspaceId", router: createHeartbeatsRouter(service, deps.guards) },
    ],
    rawBodyRouters: [{ path: "/api/hb", router: createPingRouter(service) }],
    sweeps: [
      {
        kind: "heartbeat-misses",
        everyMs: HEARTBEAT_SWEEP_EVERY_MS,
        async run(logger) {
          const outcome = await service.sweep();
          if (outcome.missed + outcome.suppressed + outcome.tooLong > 0) {
            logger.info(outcome, "heartbeat sweep");
          }
        },
      },
      {
        kind: "platform-tick",
        everyMs: PLATFORM_TICK_EVERY_MS,
        run: () => service.platformTick(),
      },
    ],
    apiTimers: [
      { name: "platform-tick", everyMs: PLATFORM_TICK_EVERY_MS, run: () => service.apiTick() },
    ],
  };
}
