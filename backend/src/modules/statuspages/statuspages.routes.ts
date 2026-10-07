/*
 * /api/w/:workspaceId/status-pages: session → workspace → role → validate → controller (§6.11).
 * Everyone but billing sees the pages; members edit them and post updates, as they manage monitors.
 * /api/public/status/:ref is the public zone (§7.1): no session, read-only, cached.
 */
import { Router, urlencoded, type RequestHandler } from "express";
import { NotFoundError } from "../../core/errors.js";
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
  setDomainBody,
  subscribeBody,
  subscriberIdParams,
  subscriptionTokenQuery,
  tlsAskQuery,
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
  router.put(
    "/status-pages/:pageId/domain",
    write,
    validate({ params: pageIdParams, body: setDomainBody }),
    controller.setDomain,
  );
  router.post("/status-pages/:pageId/domain/verify", write, page, controller.verifyDomain);
  router.get("/status-pages/:pageId/subscribers", read, page, controller.subscribers);
  router.delete(
    "/status-pages/:pageId/subscribers/:subscriberId",
    write,
    validate({ params: subscriberIdParams }),
    controller.removeSubscriber,
  );

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

/*
 * /api/internal/tls/ask (§7.1 "Internal", §16): Caddy asks here before it gets a certificate for a
 * host it doesn't know. Caddy never forwards the public internet to /api/internal/*; as a second
 * lock, a request that came through a proxy (it carries a forwarding header) is refused.
 */
export function createInternalTlsRouter(controller: StatuspagesController): Router {
  const router = Router();
  const direct: RequestHandler = (req, _res, next) => {
    if (req.headers["x-forwarded-for"] !== undefined || req.headers.forwarded !== undefined) {
      next(new NotFoundError());
      return;
    }
    next();
  };
  router.get("/ask", direct, validate({ query: tlsAskQuery }), controller.tlsAsk);
  return router;
}

export function createPublicStatusRouter(controller: StatuspagesController): Router {
  const router = Router();
  const ref = validate({ params: publicRefParams });
  router.get("/:ref", ref, controller.publicPage);
  router.get("/:ref/rss", ref, controller.publicRss);
  router.get("/:ref/atom", ref, controller.publicAtom);
  /* The page's subscribe form posts as a plain HTML form; API clients post JSON. */
  router.post(
    "/:ref/subscribers",
    urlencoded({ extended: false, limit: "10kb" }),
    validate({ params: publicRefParams, body: subscribeBody }),
    controller.subscribe,
  );
  return router;
}

/* /api/public/status-subscriptions: the links in subscriber emails (no session, token in the URL). */
export function createSubscriptionLinksRouter(controller: StatuspagesController): Router {
  const router = Router();
  const token = validate({ query: subscriptionTokenQuery });
  router.get("/confirm", token, controller.confirmSubscription);
  router.get("/unsubscribe", token, controller.unsubscribe);
  router.post("/unsubscribe", token, controller.unsubscribeOneClick);
  return router;
}
