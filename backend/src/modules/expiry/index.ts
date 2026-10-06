/* Public API of the expiry module. Other modules import only from this file (PRODUCT.md §7.1). */
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import type { AppModule, Infra } from "../../composition/types.js";
import { newId } from "../../infra/ids.js";
import { requireRole } from "../../middleware/roles.js";
import { inputOf, validate } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import type { IncidentsService } from "../incidents/index.js";
import type { MonitorsService } from "../monitors/index.js";
import type { ResultsService } from "../results/index.js";
import { createExpiryRepository } from "./expiry.repository.js";
import { createExpiryService, type ExpiryService } from "./expiry.service.js";

export type { ExpiryService, ExpiryStatus, ExpiryView } from "./expiry.service.js";

/* §9.8: a daily sweep. */
export const EXPIRY_SWEEP_EVERY_MS = 86_400_000;

export interface ExpiryModuleDeps {
  infra: Pick<Infra, "db" | "clock" | "logger" | "http">;
  monitors: MonitorsService;
  results: ResultsService;
  incidents: IncidentsService;
  guards: { session: RequestHandler; workspace: RequestHandler };
}

export interface ExpiryModule extends AppModule {
  service: ExpiryService;
}

const monitorParams = z.object({ monitorId: z.uuid() });

/* /api/w/:workspaceId/expiry/:monitorId: state (viewers and above) and "check now" (members). */
function createExpiryRouter(
  service: ExpiryService,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  router.use("/expiry", guards.session, guards.workspace);
  router.get(
    "/expiry/:monitorId",
    requireRole("viewer"),
    validate({ params: monitorParams }),
    async (req, res) => {
      const { params } = inputOf<{ params: typeof monitorParams }>(req, res);
      res.json(await service.get(scopeOf(req, res), params.monitorId));
    },
  );
  router.post(
    "/expiry/:monitorId/check",
    requireRole("member"),
    validate({ params: monitorParams }),
    async (req, res) => {
      const { params } = inputOf<{ params: typeof monitorParams }>(req, res);
      res.json(await service.check(scopeOf(req, res), params.monitorId));
    },
  );
  return router;
}

export function createExpiryModule(deps: ExpiryModuleDeps): ExpiryModule {
  const service = createExpiryService({
    db: deps.infra.db,
    repository: createExpiryRepository(),
    monitors: deps.monitors,
    results: deps.results,
    incidents: deps.incidents,
    http: deps.infra.http,
    clock: deps.infra.clock,
    logger: deps.infra.logger.child({ module: "expiry" }),
    newId,
  });
  return {
    name: "expiry",
    service,
    routers: [{ path: "/api/w/:workspaceId", router: createExpiryRouter(service, deps.guards) }],
    sweeps: [
      {
        kind: "expiry",
        everyMs: EXPIRY_SWEEP_EVERY_MS,
        async run(logger) {
          logger.info(await service.sweep(), "expiry sweep");
        },
      },
    ],
  };
}
