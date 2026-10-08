/* HTTP in and out only; no business logic. */
import type { RequestHandler } from "express";
import { inputOf } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import type { AiService } from "./ai.service.js";
import type { feedbackBody, generationIdParams, incidentRefParams } from "./validators/index.js";

export type AiController = Record<"feedback" | "get" | "draftPostmortem", RequestHandler>;

export function createAiController(service: AiService): AiController {
  return {
    draftPostmortem: async (req, res) => {
      const { params } = inputOf<{ params: typeof incidentRefParams }>(req, res);
      res.json(await service.draftPostmortem(scopeOf(req, res), params.incidentRef));
    },
    get: async (req, res) => {
      const { params } = inputOf<{ params: typeof generationIdParams }>(req, res);
      res.json({
        generationId: params.generationId,
        feedback: await service.feedbackOf(scopeOf(req, res), params.generationId),
      });
    },
    feedback: async (req, res) => {
      const { params, body } = inputOf<{
        params: typeof generationIdParams;
        body: typeof feedbackBody;
      }>(req, res);
      const row = await service.feedback(scopeOf(req, res), params.generationId, body.feedback);
      res.json({ generationId: row.id, feedback: row.feedback });
    },
  };
}
