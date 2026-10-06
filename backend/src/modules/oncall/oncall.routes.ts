/*
 * /api/w/:workspaceId/schedules: session → workspace → permission → validate → controller (§6.11).
 * Everyone but billing sees who is on call; admins define schedules; responders and above add
 * overrides ("cover for me").
 */
import { Router, type RequestHandler } from "express";
import { requirePermission } from "../../middleware/roles.js";
import { validate } from "../../middleware/validate.js";
import type { OncallController } from "./oncall.controller.js";
import {
  createOverrideBody,
  createScheduleBody,
  onCallQuery,
  overrideIdParams,
  scheduleIdParams,
  timelineQuery,
  updateScheduleBody,
} from "./validators/index.js";

export function createOncallRouter(
  controller: OncallController,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  const read = requirePermission("schedule:read");
  const write = requirePermission("schedule:write");
  const override = requirePermission("schedule:override");
  const id = validate({ params: scheduleIdParams });
  router.use("/schedules", guards.session, guards.workspace);

  router.get("/schedules", read, controller.list);
  router.post("/schedules", write, validate({ body: createScheduleBody }), controller.create);
  router.get("/schedules/:scheduleId", read, id, controller.get);
  router.patch(
    "/schedules/:scheduleId",
    write,
    validate({ params: scheduleIdParams, body: updateScheduleBody }),
    controller.update,
  );
  router.delete("/schedules/:scheduleId", write, id, controller.remove);

  router.get(
    "/schedules/:scheduleId/on-call",
    read,
    validate({ params: scheduleIdParams, query: onCallQuery }),
    controller.onCall,
  );
  router.get(
    "/schedules/:scheduleId/timeline",
    read,
    validate({ params: scheduleIdParams, query: timelineQuery }),
    controller.timeline,
  );

  router.post(
    "/schedules/:scheduleId/overrides",
    override,
    validate({ params: scheduleIdParams, body: createOverrideBody }),
    controller.addOverride,
  );
  router.delete(
    "/schedules/:scheduleId/overrides/:overrideId",
    override,
    validate({ params: overrideIdParams }),
    controller.removeOverride,
  );
  return router;
}
