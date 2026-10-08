/*
 * /api/w/:workspaceId/reports: session → workspace → role → validate → controller. Anyone who can
 * see monitors can read a report; schedules send email to people outside the workspace, so they
 * are for admins (`settings:update`).
 * /api/public/reports is the public zone (§7.1): links from report emails, which carry a signed
 * token instead of a session.
 */
import { Router, type RequestHandler } from "express";
import { requirePermission } from "../../middleware/roles.js";
import { validate } from "../../middleware/validate.js";
import type { ReportsController } from "./reports.controller.js";
import {
  scheduleBody,
  scheduleIdParams,
  sharedReportParams,
  slaQuery,
  unsubscribeQuery,
} from "./validators/index.js";

export function createReportsRouter(
  controller: ReportsController,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  router.use("/reports", guards.session, guards.workspace);
  const read = requirePermission("monitor:read");
  const manage = requirePermission("settings:update");
  const query = validate({ query: slaQuery });
  router.get("/reports/sla", read, query, controller.sla);
  router.get("/reports/sla.csv", read, query, controller.slaCsv);
  router.get("/reports/sla.pdf", read, query, controller.slaPdf);
  router.get("/reports/schedules", read, controller.listSchedules);
  router.post(
    "/reports/schedules",
    manage,
    validate({ body: scheduleBody }),
    controller.createSchedule,
  );
  router.put(
    "/reports/schedules/:scheduleId",
    manage,
    validate({ params: scheduleIdParams, body: scheduleBody }),
    controller.updateSchedule,
  );
  router.delete(
    "/reports/schedules/:scheduleId",
    manage,
    validate({ params: scheduleIdParams }),
    controller.deleteSchedule,
  );
  return router;
}

export function createPublicReportsRouter(controller: ReportsController): Router {
  const router = Router();
  const token = validate({ query: unsubscribeQuery });
  router.get("/unsubscribe", token, controller.unsubscribe);
  router.post("/unsubscribe", token, controller.unsubscribeOneClick);
  router.get("/:token/sla.pdf", validate({ params: sharedReportParams }), controller.sharedPdf);
  return router;
}
