/*
 * /api/w/:workspaceId/{monitors,monitor-groups,tags}: session → workspace → role → validate → controller.
 * Everyone but billing reads; members and above change configuration (§6.11). The billing role
 * reads only the usage meters.
 */
import { Router, type RequestHandler } from "express";
import { requirePermission } from "../../middleware/roles.js";
import { validate } from "../../middleware/validate.js";
import type { MonitorsController } from "./monitors.controller.js";
import {
  createMonitorBody,
  groupBody,
  groupIdParams,
  listMonitorsQuery,
  monitorIdParams,
  updateMonitorBody,
} from "./validators/index.js";

export function createMonitorsRouter(
  controller: MonitorsController,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  const read = requirePermission("monitor:read");
  const write = requirePermission("monitor:write");
  router.use(guards.session, guards.workspace);

  router.get("/monitors", read, validate({ query: listMonitorsQuery }), controller.list);
  router.post("/monitors", write, validate({ body: createMonitorBody }), controller.create);
  router.get("/monitors/:monitorId", read, validate({ params: monitorIdParams }), controller.get);
  router.patch(
    "/monitors/:monitorId",
    write,
    validate({ params: monitorIdParams, body: updateMonitorBody }),
    controller.update,
  );
  router.post(
    "/monitors/:monitorId/pause",
    write,
    validate({ params: monitorIdParams }),
    controller.pause,
  );
  router.post(
    "/monitors/:monitorId/resume",
    write,
    validate({ params: monitorIdParams }),
    controller.resume,
  );
  router.delete(
    "/monitors/:monitorId",
    write,
    validate({ params: monitorIdParams }),
    controller.remove,
  );

  /* Active monitors against the plan's limits (billing page meters, upgrade prompts). */
  router.get("/monitor-usage", requirePermission("billing:read"), controller.usage);

  router.get("/tags", read, controller.tags);

  router.get("/monitor-groups", read, controller.groups);
  router.post("/monitor-groups", write, validate({ body: groupBody }), controller.createGroup);
  router.patch(
    "/monitor-groups/:groupId",
    write,
    validate({ params: groupIdParams, body: groupBody }),
    controller.renameGroup,
  );
  router.delete(
    "/monitor-groups/:groupId",
    write,
    validate({ params: groupIdParams }),
    controller.deleteGroup,
  );
  return router;
}
