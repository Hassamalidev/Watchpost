/*
 * /api/w/:workspaceId/* — session → workspace scope → role → validation → controller (§7.9).
 * Creating workspaces, inviting and accepting go through Better Auth at /api/auth/organization/*.
 */
import { Router, type RequestHandler } from "express";
import { requirePermission } from "../../middleware/roles.js";
import { validate } from "../../middleware/validate.js";
import { createClientBody, updateSettingsBody } from "./validators/index.js";
import type { WorkspacesController } from "./workspaces.controller.js";

export function createWorkspacesRouter(
  controller: WorkspacesController,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  router.use(guards.session, guards.workspace);
  /* Every role, billing included: the web app asks who you are here before showing anything. */
  router.get("/me", requirePermission("settings:read"), controller.me);
  router.get("/members", requirePermission("roster:read"), controller.members);
  /* An agency's client workspaces: admins see and create them. */
  router.get("/client-workspaces", requirePermission("settings:update"), controller.listClients);
  router.post(
    "/client-workspaces",
    requirePermission("settings:update"),
    validate({ body: createClientBody }),
    controller.createClient,
  );
  router.get("/settings", requirePermission("settings:read"), controller.getSettings);
  router.patch(
    "/settings",
    requirePermission("settings:update"),
    validate({ body: updateSettingsBody }),
    controller.updateSettings,
  );
  return router;
}
