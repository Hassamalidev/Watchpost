/*
 * Two route families:
 * - probe protocol (/api/probe/v1/*), mounted behind probe authentication by the container;
 * - "Test now" for users (/api/w/:workspaceId/*), behind the workspace guards.
 */
import { Router, type RequestHandler } from "express";
import { requirePermission } from "../../middleware/roles.js";
import { validate } from "../../middleware/validate.js";
import type { ProbesController } from "./probes.controller.js";
import { monitorIdParams, taskIdParams } from "./validators/index.js";

export function createProbeProtocolRouter(controller: ProbesController): Router {
  const router = Router();
  router.post("/hello", controller.hello);
  router.get("/assignments", controller.assignments);
  router.get("/tasks", controller.tasks);
  router.post("/heartbeat", controller.heartbeat);
  return router;
}

export function createProbeUserRouter(
  controller: ProbesController,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  router.use(guards.session, guards.workspace);
  router.post(
    "/monitors/:monitorId/test",
    requirePermission("monitor:write"),
    validate({ params: monitorIdParams }),
    controller.testNow,
  );
  router.get("/check-regions", requirePermission("monitor:read"), controller.regions);
  router.get(
    "/probe-tasks/:taskId",
    requirePermission("monitor:read"),
    validate({ params: taskIdParams }),
    controller.getTask,
  );
  return router;
}
