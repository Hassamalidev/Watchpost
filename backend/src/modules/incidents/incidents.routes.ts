/*
 * /api/w/:workspaceId/incidents: session → workspace → role → validate → controller (§6.11).
 * Viewers and above read; responders acknowledge, resolve and comment; members open incidents by hand
 * and mark false alarms. The billing role sees billing pages only.
 */
import { Router, type RequestHandler } from "express";
import { requireRole } from "../../middleware/roles.js";
import { validate } from "../../middleware/validate.js";
import type { IncidentsController } from "./incidents.controller.js";
import {
  commentBody,
  createIncidentBody,
  falseAlarmBody,
  incidentRefParams,
  listIncidentsQuery,
} from "./validators/index.js";

export function createIncidentsRouter(
  controller: IncidentsController,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  const read = requireRole("viewer");
  const respond = requireRole("responder");
  const write = requireRole("member");
  const ref = validate({ params: incidentRefParams });
  router.use("/incidents", guards.session, guards.workspace);

  router.get("/incidents", read, validate({ query: listIncidentsQuery }), controller.list);
  router.post("/incidents", write, validate({ body: createIncidentBody }), controller.create);
  router.get("/incidents/:incidentRef", read, ref, controller.get);
  router.post("/incidents/:incidentRef/acknowledge", respond, ref, controller.acknowledge);
  router.post("/incidents/:incidentRef/resolve", respond, ref, controller.resolve);
  router.post(
    "/incidents/:incidentRef/comments",
    respond,
    validate({ params: incidentRefParams, body: commentBody }),
    controller.comment,
  );
  router.post(
    "/incidents/:incidentRef/false-alarm",
    write,
    validate({ params: incidentRefParams, body: falseAlarmBody }),
    controller.falseAlarm,
  );
  return router;
}
