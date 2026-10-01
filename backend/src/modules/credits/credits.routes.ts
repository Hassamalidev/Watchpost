/*
 * /api/w/:workspaceId/credits: the workspace's SMS and voice credits and their recent history. Every
 * member may read it (the billing role included); credits change only through payments and alerts.
 */
import { Router, type RequestHandler } from "express";
import { scopeOf } from "../../middleware/workspace.js";
import type { CreditsService } from "./credits.service.js";

export function createCreditsRouter(
  service: Pick<CreditsService, "state">,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  router.get("/credits", guards.session, guards.workspace, async (req, res) => {
    res.json(await service.state(scopeOf(req, res)));
  });
  return router;
}
