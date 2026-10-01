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
  summaryQuery,
  tuningParams,
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
  router.use(["/incidents", "/alert-tuning"], guards.session, guards.workspace);

  /* Alert tuning advice from the last 30 days of incidents (P1-T28). */
  router.get("/alert-tuning", read, controller.noisiest);
  router.get(
    "/alert-tuning/:monitorId",
    read,
    validate({ params: tuningParams }),
    controller.tuning,
  );

  router.get("/incidents", read, validate({ query: listIncidentsQuery }), controller.list);
  router.get("/incidents/summary", read, validate({ query: summaryQuery }), controller.summary);
  /* Drills page everyone in the alert routes, so they are for admins. */
  router.post("/incidents/drill", requireRole("admin"), controller.drill);
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
