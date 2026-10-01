/*
 * Billing routes (PRODUCT.md §11).
 * - /api/w/:workspaceId/entitlements and /billing: every member reads the plan and its limits; owners,
 *   admins and the billing role change it (the billing role sees billing pages only, §6.11).
 * - /api/webhooks/paddle: raw body, signature checked before anything is parsed (§7.9 step 3).
 */
import express, { Router, type RequestHandler } from "express";
import { ForbiddenError } from "../../core/errors.js";
import type { RedisClient } from "../../infra/redis.js";
import { PADDLE_SIGNATURE_HEADER } from "../../infra/paddle/index.js";
import { createRateLimiter } from "../../middleware/rate-limit.js";
import { validate } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import type { BillingController } from "./billing.controller.js";
import type { PaddleSync } from "./paddle-sync.js";
import { buyCreditsBody, cancelBody, planBody } from "./validators/index.js";

const MANAGERS = new Set(["owner", "admin", "billing", "system"]);

/* Owners, admins and the billing role manage the subscription. */
export const requireBillingManager: RequestHandler = (req, res, next) => {
  const scope = scopeOf(req, res);
  if (!MANAGERS.has(scope.role)) {
    next(new ForbiddenError("Only owners, admins and billing members can change billing."));
    return;
  }
  next();
};

export function createBillingRouter(
  controller: BillingController,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  router.use(["/entitlements", "/billing"], guards.session, guards.workspace);

  router.get("/entitlements", controller.entitlements);
  router.get("/billing", controller.state);

  const manage = [requireBillingManager];
  router.post("/billing/checkout", ...manage, validate({ body: planBody }), controller.checkout);
  router.post("/billing/plan", ...manage, validate({ body: planBody }), controller.changePlan);
  router.post(
    "/billing/credits",
    ...manage,
    validate({ body: buyCreditsBody }),
    controller.buyCredits,
  );
  router.post("/billing/cancel", ...manage, validate({ body: cancelBody }), controller.cancel);
  router.post("/billing/pause", ...manage, controller.pause);
  router.post("/billing/resume", ...manage, controller.resume);
  router.post("/billing/portal", ...manage, controller.portal);
  return router;
}

/* Paddle answers 2xx as "delivered"; anything else is retried for up to three days. */
const STATUS: Record<Awaited<ReturnType<PaddleSync["ingest"]>>, number> = {
  accepted: 200,
  duplicate: 200,
  bad_signature: 401,
  invalid: 400,
  not_configured: 503,
};

export function createPaddleWebhookRouter(
  sync: Pick<PaddleSync, "ingest">,
  redis: RedisClient,
): Router {
  const router = Router();
  router.use(createRateLimiter({ redis, name: "paddle-webhook", windowMs: 60_000, limit: 1_200 }));
  router.post("/", express.raw({ type: () => true, limit: "1mb" }), async (req, res) => {
    const outcome = await sync.ingest(
      Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      req.get(PADDLE_SIGNATURE_HEADER),
    );
    res.status(STATUS[outcome]).json({ outcome });
  });
  return router;
}
