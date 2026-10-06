/*
 * /api/w/:workspaceId/* — session → workspace scope → role → validation → controller (§7.9).
 * Creating workspaces, inviting and accepting go through Better Auth at /api/auth/organization/*.
 */
import { Router, type RequestHandler } from "express";
import { requireRole } from "../../middleware/roles.js";
import { validate } from "../../middleware/validate.js";
import { updateSettingsBody } from "./validators/index.js";
import type { WorkspacesController } from "./workspaces.controller.js";

export function createWorkspacesRouter(
  controller: WorkspacesController,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  router.use(guards.session, guards.workspace);
  router.get("/me", controller.me);
  router.get("/members", requireRole("admin"), controller.members);
  router.get("/settings", controller.getSettings);
  router.patch(
    "/settings",
    requireRole("admin"),
    validate({ body: updateSettingsBody }),
    controller.updateSettings,
  );
  return router;
}
