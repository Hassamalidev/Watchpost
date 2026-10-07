/*
 * /api/public/badges/:token/:file is the public zone (§7.1): no session, read-only, cached.
 * /api/w/:workspaceId/monitors/:monitorId/badges hands the signed URLs to people who may see the
 * monitor: session → workspace → role → validate → controller.
 */
import { Router, type RequestHandler } from "express";
import { requirePermission } from "../../middleware/roles.js";
import { validate } from "../../middleware/validate.js";
import type { BadgesController } from "./badges.controller.js";
import { badgeParams, badgeQuery, monitorIdParams } from "./validators/index.js";

export function createBadgesRouter(
  controller: BadgesController,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  router.get(
    "/monitors/:monitorId/badges",
    guards.session,
    guards.workspace,
    requirePermission("monitor:read"),
    validate({ params: monitorIdParams }),
    controller.links,
  );
  return router;
}

export function createPublicBadgesRouter(controller: BadgesController): Router {
  const router = Router();
  router.get(
    "/:token/:file",
    validate({ params: badgeParams, query: badgeQuery }),
    controller.badge,
  );
  return router;
}
