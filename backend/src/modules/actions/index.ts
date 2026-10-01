/* Public API of the actions module. Other modules import only from this file (PRODUCT.md §7.1). */
import { Router } from "express";
import { z } from "zod";
import type { AppModule, Infra } from "../../composition/types.js";
import { validate, inputOf } from "../../middleware/validate.js";
import type { MessagingProvider } from "../../infra/messaging/index.js";
import type { PhonesService } from "../channels/index.js";
import type { IncidentsService } from "../incidents/index.js";
import type { WorkspacesService } from "../workspaces/index.js";
import { createActionsRepository } from "./actions.repository.js";
import { createActionsService, type ActionsService } from "./actions.service.js";
import { createPhoneActionsRouter } from "./phone.routes.js";

export type { ActionOutcome, ActionPreview, ActionsService } from "./actions.service.js";

export interface ActionsModuleDeps {
  infra: Pick<Infra, "db" | "clock" | "actionLinks" | "config">;
  incidents: IncidentsService;
  workspaces: WorkspacesService;
  /* SMS replies and call keypresses; both absent when the server has no messaging provider. */
  phones?: Pick<PhonesService, "replyTarget"> | undefined;
  messaging?: MessagingProvider | undefined;
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
    phones: deps.phones,
    clock: deps.infra.clock,
  });
  const phoneRouters =
    deps.messaging === undefined || deps.phones === undefined
      ? []
      : [
          {
            path: "/",
            router: createPhoneActionsRouter(service, {
              messaging: deps.messaging,
              publicUrl: deps.infra.config.auth.baseURL,
            }),
          },
        ];
  return {
    name: "actions",
    service,
    routers: [{ path: "/", router: createActionsRouter(service) }, ...phoneRouters],
  };
}
