/*
 * /api/w/:workspaceId/maintenance-windows: session → workspace → role → validate → controller (§6.11).
 * Everyone but billing sees the windows; members plan them, like they manage monitors.
 */
import { Router, type RequestHandler } from "express";
import { requirePermission } from "../../middleware/roles.js";
import { validate } from "../../middleware/validate.js";
import type { MaintenanceController } from "./maintenance.controller.js";
import { createWindowBody, updateWindowBody, windowIdParams } from "./validators/index.js";

export function createMaintenanceRouter(
  controller: MaintenanceController,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  const read = requirePermission("maintenance:read");
  const write = requirePermission("maintenance:write");
  const id = validate({ params: windowIdParams });
  router.use("/maintenance-windows", guards.session, guards.workspace);

  router.get("/maintenance-windows", read, controller.list);
  router.post(
    "/maintenance-windows",
    write,
    validate({ body: createWindowBody }),
    controller.create,
  );
  router.get("/maintenance-windows/:windowId", read, id, controller.get);
  router.patch(
    "/maintenance-windows/:windowId",
    write,
    validate({ params: windowIdParams, body: updateWindowBody }),
    controller.update,
  );
  router.delete("/maintenance-windows/:windowId", write, id, controller.remove);
  return router;
}
