/* Public API of the imports module. Other modules import only from this file (PRODUCT.md §7.1). */
import { Router, type RequestHandler } from "express";
import { importRequestSchema } from "@app/shared";
import type { AppModule, Infra } from "../../composition/types.js";
import { newId } from "../../infra/ids.js";
import { requirePermission } from "../../middleware/roles.js";
import { inputOf, validate } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import type { MonitorsService } from "../monitors/index.js";
import type { OncallService } from "../oncall/index.js";
import type { WorkspacesService } from "../workspaces/index.js";
import { createImportsRepository } from "./imports.repository.js";
import { createImportsService, type ImportsService } from "./imports.service.js";

export type { ImportsService } from "./imports.service.js";
export { mapImport, type PlannedItem } from "./mappers.js";

export interface ImportsModuleDeps {
  infra: Pick<Infra, "db" | "http">;
  monitors: MonitorsService;
  oncall: OncallService;
  workspaces: WorkspacesService;
  guards: { session: RequestHandler; workspace: RequestHandler };
}

export interface ImportsModule extends AppModule {
  service: ImportsService;
}

/*
 * /api/w/:workspaceId/imports: an import creates monitors, schedules and escalation policies in
 * bulk, so it is for admins and owners (§6.11).
 */
function createImportsRouter(
  service: ImportsService,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  const admin = requirePermission("settings:update");
  router.use("/imports", guards.session, guards.workspace);
  router.get("/imports", admin, async (req, res) => {
    res.json({ data: await service.history(scopeOf(req, res)) });
  });
  router.post(
    "/imports/dry-run",
    admin,
    validate({ body: importRequestSchema }),
    async (req, res) => {
      const { body } = inputOf<{ body: typeof importRequestSchema }>(req, res);
      res.json(await service.dryRun(scopeOf(req, res), body));
    },
  );
  router.post("/imports", admin, validate({ body: importRequestSchema }), async (req, res) => {
    const { body } = inputOf<{ body: typeof importRequestSchema }>(req, res);
    res.status(201).json(await service.apply(scopeOf(req, res), body));
  });
  return router;
}

export function createImportsModule(deps: ImportsModuleDeps): ImportsModule {
  const service = createImportsService({
    db: deps.infra.db,
    repository: createImportsRepository(),
    monitors: deps.monitors,
    oncall: deps.oncall,
    workspaces: deps.workspaces,
    http: deps.infra.http,
    newId,
  });
  return {
    name: "imports",
    service,
    routers: [{ path: "/api/w/:workspaceId", router: createImportsRouter(service, deps.guards) }],
  };
}
