/*
 * /api/w/:workspaceId/me/{contact-methods,notification-rules}: session → workspace → permission →
 * validate → controller. Your own contact methods and rules; anyone who can be paged has them
 * (responders and above, §6.11).
 */
import { Router, type RequestHandler } from "express";
import { requirePermission } from "../../middleware/roles.js";
import { validate } from "../../middleware/validate.js";
import type { ContactsController } from "./contacts.controller.js";
import {
  confirmBody,
  createMethodBody,
  methodIdParams,
  replaceRulesBody,
  urgencyParams,
} from "./validators/index.js";

export function createContactsRouter(
  controller: ContactsController,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  const own = requirePermission("contact:manage");
  const id = validate({ params: methodIdParams });
  router.use(["/me/contact-methods", "/me/notification-rules"], guards.session, guards.workspace);

  router.get("/me/contact-methods", own, controller.list);
  router.post("/me/contact-methods", own, validate({ body: createMethodBody }), controller.add);
  router.delete("/me/contact-methods/:methodId", own, id, controller.remove);
  router.post("/me/contact-methods/:methodId/code", own, id, controller.requestCode);
  router.post(
    "/me/contact-methods/:methodId/confirm",
    own,
    validate({ params: methodIdParams, body: confirmBody }),
    controller.confirm,
  );

  router.get("/me/notification-rules", own, controller.rules);
  router.put(
    "/me/notification-rules/:urgency",
    own,
    validate({ params: urgencyParams, body: replaceRulesBody }),
    controller.replaceRules,
  );
  return router;
}
