/*
 * /api/w/:workspaceId/status-pages: session → workspace → role → validate → controller (§6.11).
 * Everyone but billing sees the pages; members edit them and post updates, as they manage monitors.
 * /api/public/status/:ref is the public zone (§7.1): no session, read-only, cached.
 */
import { Router, type RequestHandler } from "express";
import { requirePermission } from "../../middleware/roles.js";
import { validate } from "../../middleware/validate.js";
import type { StatuspagesController } from "./statuspages.controller.js";
import {
  createIncidentBody,
  createPageBody,
  incidentIdParams,
  pageIdParams,
  postUpdateBody,
  publicRefParams,
  replaceComponentsBody,
  updateIncidentBody,
  updatePageBody,
} from "./validators/index.js";

export function createStatuspagesRouter(
  controller: StatuspagesController,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  const read = requirePermission("statusPage:read");
  const write = requirePermission("statusPage:write");
  const page = validate({ params: pageIdParams });
  const incident = validate({ params: incidentIdParams });
  router.use("/status-pages", guards.session, guards.workspace);

  router.get("/status-pages", read, controller.list);
  router.post("/status-pages", write, validate({ body: createPageBody }), controller.create);
  router.get("/status-pages/:pageId", read, page, controller.get);
  router.patch(
    "/status-pages/:pageId",
    write,
    validate({ params: pageIdParams, body: updatePageBody }),
    controller.update,
  );
  router.delete("/status-pages/:pageId", write, page, controller.remove);
  router.put(
    "/status-pages/:pageId/components",
    write,
    validate({ params: pageIdParams, body: replaceComponentsBody }),
    controller.replaceComponents,
  );
  router.get("/status-pages/:pageId/preview", read, page, controller.preview);

  router.get("/status-pages/:pageId/incidents", read, page, controller.listIncidents);
  router.post(
    "/status-pages/:pageId/incidents",
    write,
    validate({ params: pageIdParams, body: createIncidentBody }),
    controller.createIncident,
  );
  router.patch(
    "/status-pages/:pageId/incidents/:incidentId",
    write,
    validate({ params: incidentIdParams, body: updateIncidentBody }),
    controller.updateIncident,
  );
  router.post(
    "/status-pages/:pageId/incidents/:incidentId/updates",
    write,
    validate({ params: incidentIdParams, body: postUpdateBody }),
    controller.postUpdate,
  );
  router.delete(
    "/status-pages/:pageId/incidents/:incidentId",
    write,
    incident,
    controller.removeIncident,
  );
  return router;
}

export function createPublicStatusRouter(controller: StatuspagesController): Router {
  const router = Router();
  const ref = validate({ params: publicRefParams });
  router.get("/:ref", ref, controller.publicPage);
  router.get("/:ref/rss", ref, controller.publicRss);
  router.get("/:ref/atom", ref, controller.publicAtom);
  return router;
}
