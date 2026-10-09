/* HTTP in and out only; no business logic. */
import type { RequestHandler } from "express";
import { sessionOf } from "../../middleware/session.js";
import { inputOf } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import type { PrivacyService } from "./privacy.service.js";
import type { requestDeletionBody } from "./validators/index.js";

export type PrivacyController = Record<
  "export" | "deletion" | "requestDeletion" | "cancelDeletion",
  RequestHandler
>;

export function createPrivacyController(service: PrivacyService): PrivacyController {
  return {
    export: async (req, res) => {
      const scope = scopeOf(req, res);
      const data = await service.export(scope);
      const day = data.exportedAt.slice(0, 10);
      res
        .set("cache-control", "private, no-store")
        .set(
          "content-disposition",
          `attachment; filename="workspace-${scope.workspaceId}-${day}.json"`,
        )
        .json(data);
    },
    deletion: async (req, res) => {
      res.json(await service.deletion(scopeOf(req, res)));
    },
    requestDeletion: async (req, res) => {
      const { body } = inputOf<{ body: typeof requestDeletionBody }>(req, res);
      res
        .status(201)
        .json(await service.requestDeletion(scopeOf(req, res), body.confirm, sessionOf(req, res)));
    },
    cancelDeletion: async (req, res) => {
      res.json(await service.cancelDeletion(scopeOf(req, res)));
    },
  };
}
