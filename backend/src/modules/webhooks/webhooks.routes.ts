/*
 * /api/w/:workspaceId/webhooks: session → workspace → role → validate → controller. Webhooks are
 * integrations: whoever may see channels sees them (`channel:read`), and whoever manages channels
 * manages them (`channel:manage`), because a webhook sends workspace data to an address outside.
 */
import { Router, type RequestHandler } from "express";
import { requirePermission } from "../../middleware/roles.js";
import { validate } from "../../middleware/validate.js";
import type { WebhooksController } from "./webhooks.controller.js";
import {
  createWebhookBody,
  deliveriesQuery,
  deliveryParams,
  testWebhookBody,
  updateWebhookBody,
  webhookIdParams,
} from "./validators/index.js";

export function createWebhooksRouter(
  controller: WebhooksController,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  router.use(["/webhooks", "/webhook-events"], guards.session, guards.workspace);
  const read = requirePermission("channel:read");
  const manage = requirePermission("channel:manage");
  const id = validate({ params: webhookIdParams });
  router.get("/webhook-events", read, controller.catalog);
  router.get("/webhooks", read, controller.list);
  router.post("/webhooks", manage, validate({ body: createWebhookBody }), controller.create);
  router.patch(
    "/webhooks/:webhookId",
    manage,
    validate({ params: webhookIdParams, body: updateWebhookBody }),
    controller.update,
  );
  router.delete("/webhooks/:webhookId", manage, id, controller.remove);
  router.post("/webhooks/:webhookId/secret", manage, id, controller.rotateSecret);
  router.get(
    "/webhooks/:webhookId/deliveries",
    read,
    validate({ params: webhookIdParams, query: deliveriesQuery }),
    controller.deliveries,
  );
  router.post(
    "/webhooks/:webhookId/test",
    manage,
    validate({ params: webhookIdParams, body: testWebhookBody }),
    controller.test,
  );
  router.post(
    "/webhooks/:webhookId/deliveries/:deliveryId/replay",
    manage,
    validate({ params: deliveryParams }),
    controller.replay,
  );
  return router;
}
