/*
 * /api/w/:workspaceId/{monitors,monitor-groups,tags}: session → workspace → role → validate → controller.
 * Everyone in the workspace can read; members and above change configuration (§6.11).
 */
import { Router, type RequestHandler } from "express";
import { requireRole } from "../../middleware/roles.js";
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
  const write = requireRole("member");
  router.use(guards.session, guards.workspace);

  router.get("/monitors", validate({ query: listMonitorsQuery }), controller.list);
  router.post("/monitors", write, validate({ body: createMonitorBody }), controller.create);
  router.get("/monitors/:monitorId", validate({ params: monitorIdParams }), controller.get);
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
  router.get("/monitor-usage", controller.usage);

  router.get("/tags", controller.tags);

  router.get("/monitor-groups", controller.groups);
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
