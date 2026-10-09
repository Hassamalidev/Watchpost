/*
 * /api/w/:workspaceId/audit-log: session → workspace → role → validate → controller. The log says
 * who did what, so it is for admins (`settings:update`).
 */
import { Router, type RequestHandler } from "express";
import { requirePermission } from "../../middleware/roles.js";
import { validate } from "../../middleware/validate.js";
import type { AuditController } from "./audit.controller.js";
import { auditExportQuery, auditListQuery } from "./validators/index.js";

export function createAuditRouter(
  controller: AuditController,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  const read = [guards.session, guards.workspace, requirePermission("settings:update")];
  router.get("/audit-log", ...read, validate({ query: auditListQuery }), controller.list);
  router.get("/audit-log.csv", ...read, validate({ query: auditExportQuery }), controller.csv);
  return router;
}
