/*
 * /api/w/:workspaceId/ai: session → workspace → role → validate → controller. Feedback on an AI
 * answer comes from the people who act on incidents (§9.10).
 */
import { Router, type RequestHandler } from "express";
import { requirePermission } from "../../middleware/roles.js";
import { validate } from "../../middleware/validate.js";
import type { AiController } from "./ai.controller.js";
import { feedbackBody, generationIdParams } from "./validators/index.js";

export function createAiRouter(
  controller: AiController,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  router.put(
    "/ai/generations/:generationId/feedback",
    guards.session,
    guards.workspace,
    requirePermission("incident:respond"),
    validate({ params: generationIdParams, body: feedbackBody }),
    controller.feedback,
  );
  return router;
}
