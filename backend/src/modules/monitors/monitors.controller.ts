/* HTTP in and out only; no business logic. */
import type { RequestHandler } from "express";
import { inputOf } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import type {
  createMonitorBody,
  groupBody,
  groupIdParams,
  listMonitorsQuery,
  monitorIdParams,
  updateMonitorBody,
} from "./validators/index.js";
import type { MonitorsService } from "./monitors.service.js";

type Handlers =
  | "list"
  | "create"
  | "get"
  | "update"
  | "pause"
  | "resume"
  | "remove"
  | "tags"
  | "groups"
  | "createGroup"
  | "renameGroup"
  | "deleteGroup";

export type MonitorsController = Record<Handlers, RequestHandler>;

export function createMonitorsController(service: MonitorsService): MonitorsController {
  const idOf = (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) =>
    inputOf<{ params: typeof monitorIdParams }>(req, res).params.monitorId;
  const groupOf = (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) =>
    inputOf<{ params: typeof groupIdParams }>(req, res).params.groupId;

  return {
    list: async (req, res) => {
      const { query } = inputOf<{ query: typeof listMonitorsQuery }>(req, res);
      res.json(await service.list(scopeOf(req, res), query));
    },
    create: async (req, res) => {
      const { body } = inputOf<{ body: typeof createMonitorBody }>(req, res);
      res.status(201).json(await service.create(scopeOf(req, res), body));
    },
    get: async (req, res) => {
      res.json(await service.get(scopeOf(req, res), idOf(req, res)));
    },
    update: async (req, res) => {
      const { body } = inputOf<{ body: typeof updateMonitorBody }>(req, res);
      res.json(await service.update(scopeOf(req, res), idOf(req, res), body));
    },
    pause: async (req, res) => {
      res.json(await service.setPaused(scopeOf(req, res), idOf(req, res), true));
    },
    resume: async (req, res) => {
      res.json(await service.setPaused(scopeOf(req, res), idOf(req, res), false));
    },
    remove: async (req, res) => {
      await service.delete(scopeOf(req, res), idOf(req, res));
      res.status(204).end();
    },
    tags: async (req, res) => {
      res.json({ data: await service.listTags(scopeOf(req, res)) });
    },
    groups: async (req, res) => {
      res.json({ data: await service.listGroups(scopeOf(req, res)) });
    },
    createGroup: async (req, res) => {
      const { body } = inputOf<{ body: typeof groupBody }>(req, res);
      res.status(201).json(await service.createGroup(scopeOf(req, res), body.name));
    },
    renameGroup: async (req, res) => {
      const { body } = inputOf<{ body: typeof groupBody }>(req, res);
      res.json(await service.renameGroup(scopeOf(req, res), groupOf(req, res), body.name));
    },
    deleteGroup: async (req, res) => {
      await service.deleteGroup(scopeOf(req, res), groupOf(req, res));
      res.status(204).end();
    },
  };
}
