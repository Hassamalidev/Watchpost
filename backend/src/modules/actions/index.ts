/* Public API of the actions module. Other modules import only from this file (PRODUCT.md §7.1). */
import { Router } from "express";
import { z } from "zod";
import type { AppModule, Infra } from "../../composition/types.js";
import { validate, inputOf } from "../../middleware/validate.js";
import type { IncidentsService } from "../incidents/index.js";
import type { WorkspacesService } from "../workspaces/index.js";
import { createActionsRepository } from "./actions.repository.js";
import { createActionsService, type ActionsService } from "./actions.service.js";

export type { ActionOutcome, ActionPreview, ActionsService } from "./actions.service.js";

export interface ActionsModuleDeps {
  infra: Pick<Infra, "db" | "clock" | "actionLinks">;
  incidents: IncidentsService;
  workspaces: WorkspacesService;
}

export interface ActionsModule extends AppModule {
  service: ActionsService;
}

const tokenParams = z.object({ token: z.string().min(20).max(2_000) });

/* /api/actions/:token — no session: the signed link is the credential (single use, 24 h). */
function createActionsRouter(service: ActionsService): Router {
  const router = Router();
  router.get("/api/actions/:token", validate({ params: tokenParams }), async (req, res) => {
    const { params } = inputOf<{ params: typeof tokenParams }>(req, res);
    res.json(await service.preview(params.token));
  });
  router.post("/api/actions/:token", validate({ params: tokenParams }), async (req, res) => {
    const { params } = inputOf<{ params: typeof tokenParams }>(req, res);
    res.json(await service.perform(params.token));
  });
  return router;
}

export function createActionsModule(deps: ActionsModuleDeps): ActionsModule {
  const service = createActionsService({
    db: deps.infra.db,
    repository: createActionsRepository(),
    links: deps.infra.actionLinks,
    incidents: deps.incidents,
    workspaces: deps.workspaces,
    clock: deps.infra.clock,
  });
  return {
    name: "actions",
    service,
    routers: [{ path: "/", router: createActionsRouter(service) }],
  };
}
