/* HTTP in and out only; no business logic. */
import type { RequestHandler } from "express";
import { inputOf } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import type { MaintenanceService } from "./maintenance.service.js";
import type { createWindowBody, updateWindowBody, windowIdParams } from "./validators/index.js";

export type MaintenanceController = Record<
  "list" | "get" | "create" | "update" | "remove",
  RequestHandler
>;

export function createMaintenanceController(service: MaintenanceService): MaintenanceController {
  const idOf = (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) =>
    inputOf<{ params: typeof windowIdParams }>(req, res).params.windowId;

  return {
    list: async (req, res) => {
      res.json({ data: await service.list(scopeOf(req, res)) });
    },
    get: async (req, res) => {
      res.json(await service.get(scopeOf(req, res), idOf(req, res)));
    },
    create: async (req, res) => {
      const { body } = inputOf<{ body: typeof createWindowBody }>(req, res);
      res.status(201).json(await service.create(scopeOf(req, res), body));
    },
    update: async (req, res) => {
      const { body } = inputOf<{ body: typeof updateWindowBody }>(req, res);
      res.json(await service.update(scopeOf(req, res), idOf(req, res), body));
    },
    remove: async (req, res) => {
      await service.delete(scopeOf(req, res), idOf(req, res));
      res.status(204).end();
    },
  };
}
