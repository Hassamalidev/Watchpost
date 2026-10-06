/*
 * /api/w/:workspaceId/alert-policies: session → workspace → role → validate → controller (§6.11).
 * Viewers and above read; admins change routing (policies are part of integrations).
 */
import { Router, type RequestHandler } from "express";
import { requireRole } from "../../middleware/roles.js";
import { validate } from "../../middleware/validate.js";
import type { AlertingController } from "./alerting.controller.js";
import {
  channelIdParams,
  createPolicyBody,
  incidentIdParams,
  policyIdParams,
  updatePolicyBody,
} from "./validators/index.js";

export function createAlertingRouter(
  controller: AlertingController,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  const read = requireRole("viewer");
  const admin = requireRole("admin");
  router.use("/alert-policies", guards.session, guards.workspace);

  router.get("/alert-policies", read, controller.list);
  router.post("/alert-policies", admin, validate({ body: createPolicyBody }), controller.create);
  /* Connecting an integration: one atomic, idempotent call instead of read-then-PATCH. */
  router.put(
    "/alert-policies/default/channels/:channelId",
    admin,
    validate({ params: channelIdParams }),
    controller.routeToDefault,
  );
  router.patch(
    "/alert-policies/:policyId",
    admin,
    validate({ params: policyIdParams, body: updatePolicyBody }),
    controller.update,
  );
  router.delete(
    "/alert-policies/:policyId",
    admin,
    validate({ params: policyIdParams }),
    controller.remove,
  );
  /* Who was notified about an incident, through which channel, and whether it worked. */
  router.get(
    "/incidents/:incidentId/deliveries",
    guards.session,
    guards.workspace,
    requireRole("viewer"),
    validate({ params: incidentIdParams }),
    controller.deliveries,
  );
  /* "Send test" lives here: alerting builds alert events (it knows the workspace name). */
  router.post(
    "/channels/:channelId/test",
    guards.session,
    guards.workspace,
    admin,
    validate({ params: channelIdParams }),
    controller.sendTest,
  );
  return router;
}
