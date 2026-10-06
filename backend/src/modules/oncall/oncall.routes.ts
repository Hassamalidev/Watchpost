/*
 * /api/w/:workspaceId/schedules: session → workspace → permission → validate → controller (§6.11).
 * Everyone but billing sees who is on call; admins define schedules; responders and above add
 * overrides ("cover for me").
 */
import { Router, type RequestHandler } from "express";
import { requirePermission } from "../../middleware/roles.js";
import { validate } from "../../middleware/validate.js";
import type { OncallController } from "./oncall.controller.js";
import type { OncallService } from "./oncall.service.js";
import {
  createOverrideBody,
  createPolicyBody,
  policyIdParams,
  updatePolicyBody,
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
  router.use(
    ["/schedules", "/escalation-policies", "/me/oncall-feed"],
    guards.session,
    guards.workspace,
  );

  /* Escalation policies are defined by the same people as schedules. */
  router.get("/escalation-policies", read, controller.listPolicies);
  router.post(
    "/escalation-policies",
    write,
    validate({ body: createPolicyBody }),
    controller.createPolicy,
  );
  router.patch(
    "/escalation-policies/:policyId",
    write,
    validate({ params: policyIdParams, body: updatePolicyBody }),
    controller.updatePolicy,
  );
  router.delete(
    "/escalation-policies/:policyId",
    write,
    validate({ params: policyIdParams }),
    controller.removePolicy,
  );

  /* Your own calendar feed: for everyone who can be on call. */
  const own = requirePermission("contact:manage");
  router.get("/me/oncall-feed", own, controller.feed);
  router.post("/me/oncall-feed", own, controller.rotateFeed);
  router.delete("/me/oncall-feed", own, controller.removeFeed);

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

const FEED_TOKEN = /^[A-Za-z0-9_-]{20,64}$/;

/*
 * Token URL /api/oncall/ical/<token>.ics: the calendar a person subscribes to from their calendar
 * app. No session; the token is the secret (stored hashed, replaceable).
 */
export function createFeedRouter(service: Pick<OncallService, "calendar">): Router {
  const router = Router();
  router.get("/ical/:file", async (req, res) => {
    const file = String(req.params.file);
    const token = file.endsWith(".ics") ? file.slice(0, -4) : file;
    const body = FEED_TOKEN.test(token) ? await service.calendar(token) : undefined;
    if (body === undefined) {
      res.status(404).type("text/plain").send("Not found\n");
      return;
    }
    res
      .status(200)
      .set("Cache-Control", "private, max-age=300")
      .type("text/calendar; charset=utf-8")
      .send(body);
  });
  return router;
}
