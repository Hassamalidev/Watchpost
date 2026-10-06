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
  chatLinkBody,
  chatLinkParams,
  chatLinkQuery,
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
  router.use(
    ["/me/contact-methods", "/me/notification-rules", "/me/chat-links", "/me/push"],
    guards.session,
    guards.workspace,
  );

  /* Whether this server can notify devices, and the key a browser subscribes with. */
  router.get("/me/push", own, controller.pushConfig);

  /* Chat app users linked to you, so a button press in Slack is recorded as yours. */
  router.get("/me/chat-links", own, controller.chatLinks);
  router.get(
    "/me/chat-links/preview",
    own,
    validate({ query: chatLinkQuery }),
    controller.chatLinkPreview,
  );
  router.post("/me/chat-links", own, validate({ body: chatLinkBody }), controller.claimChatLink);
  router.delete(
    "/me/chat-links/:linkId",
    own,
    validate({ params: chatLinkParams }),
    controller.removeChatLink,
  );

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
