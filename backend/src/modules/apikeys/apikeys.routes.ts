/*
 * /api/w/:workspaceId/api-keys: session → workspace → role → validate → controller. A key acts for
 * the whole workspace, so only admins make, see and revoke keys (`settings:update`).
 */
import { Router, type RequestHandler } from "express";
import { requirePermission } from "../../middleware/roles.js";
import { validate } from "../../middleware/validate.js";
import type { ApikeysController } from "./apikeys.controller.js";
import { createKeyBody, keyIdParams } from "./validators/index.js";

export function createApikeysRouter(
  controller: ApikeysController,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  router.use("/api-keys", guards.session, guards.workspace);
  const manage = requirePermission("settings:update");
  router.get("/api-keys", manage, controller.list);
  router.post("/api-keys", manage, validate({ body: createKeyBody }), controller.create);
  router.delete("/api-keys/:keyId", manage, validate({ params: keyIdParams }), controller.revoke);
  return router;
}
