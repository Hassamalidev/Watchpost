/*
 * /api/w/:workspaceId/privacy: session → workspace → role → validate → controller. Owners and
 * admins download the workspace's data and see whether it is to be deleted; asking for deletion
 * and cancelling it is for owners, which the service checks (there is no owner-only permission).
 */
import { Router, type RequestHandler } from "express";
import { requirePermission } from "../../middleware/roles.js";
import { validate } from "../../middleware/validate.js";
import type { PrivacyController } from "./privacy.controller.js";
import { requestDeletionBody } from "./validators/index.js";

export function createPrivacyRouter(
  controller: PrivacyController,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  const admin = requirePermission("settings:update");
  router.use("/privacy", guards.session, guards.workspace);
  router.get("/privacy/export", admin, controller.export);
  router.get("/privacy/deletion", admin, controller.deletion);
  router.post(
    "/privacy/deletion",
    admin,
    validate({ body: requestDeletionBody }),
    controller.requestDeletion,
  );
  router.delete("/privacy/deletion", admin, controller.cancelDeletion);
  return router;
}
