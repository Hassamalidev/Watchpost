/* HTTP in and out only; no business logic. */
import type { RequestHandler } from "express";
import { inputOf } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import type { AiService } from "./ai.service.js";
import type { feedbackBody, generationIdParams } from "./validators/index.js";

export type AiController = Record<"feedback", RequestHandler>;

export function createAiController(service: AiService): AiController {
  return {
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
