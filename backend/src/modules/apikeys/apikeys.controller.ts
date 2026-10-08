/* HTTP in and out only; no business logic. */
import type { RequestHandler } from "express";
import { inputOf } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import type { ApikeysService } from "./apikeys.service.js";
import type { createKeyBody, keyIdParams } from "./validators/index.js";

export type ApikeysController = Record<"list" | "create" | "revoke", RequestHandler>;

export function createApikeysController(service: ApikeysService): ApikeysController {
  return {
    list: async (req, res) => {
      res.json({ data: await service.list(scopeOf(req, res)) });
    },
    create: async (req, res) => {
      const { body } = inputOf<{ body: typeof createKeyBody }>(req, res);
      /* The answer holds the key itself, so nothing on the way may keep a copy. */
      res
        .status(201)
        .set("cache-control", "no-store")
        .json(await service.create(scopeOf(req, res), body));
    },
    revoke: async (req, res) => {
      const { params } = inputOf<{ params: typeof keyIdParams }>(req, res);
      res.json(await service.revoke(scopeOf(req, res), params.keyId));
    },
  };
}
