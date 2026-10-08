/*
 * /api/w/:workspaceId/ai: session → workspace → role → validate → controller. Feedback on an AI
 * answer comes from the people who act on incidents (§9.10).
 */
import { Router, type RequestHandler } from "express";
import { requirePermission } from "../../middleware/roles.js";
import { validate } from "../../middleware/validate.js";
import type { AiController } from "./ai.controller.js";
import { feedbackBody, generationIdParams, incidentRefParams } from "./validators/index.js";

export function createAiRouter(
  controller: AiController,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  /* The draft becomes the incident's postmortem, so it needs what editing one needs. */
  router.post(
    "/incidents/:incidentRef/postmortem/draft",
    guards.session,
    guards.workspace,
    requirePermission("incident:write"),
    validate({ params: incidentRefParams }),
    controller.draftPostmortem,
  );
  router.get(
    "/ai/generations/:generationId",
    guards.session,
    guards.workspace,
    requirePermission("incident:read"),
    validate({ params: generationIdParams }),
    controller.get,
  );
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
