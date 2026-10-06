/* HTTP in and out only; no business logic. */
import type { RequestHandler } from "express";
import { inputOf } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import type { OncallService } from "./oncall.service.js";
import type {
  createOverrideBody,
  createScheduleBody,
  onCallQuery,
  overrideIdParams,
  scheduleIdParams,
  timelineQuery,
  updateScheduleBody,
} from "./validators/index.js";

export type OncallController = Record<
  | "list"
  | "get"
  | "create"
  | "update"
  | "remove"
  | "addOverride"
  | "removeOverride"
  | "onCall"
  | "timeline"
  | "feed"
  | "rotateFeed"
  | "removeFeed",
  RequestHandler
>;

export function createOncallController(service: OncallService): OncallController {
  const idOf = (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) =>
    inputOf<{ params: typeof scheduleIdParams }>(req, res).params.scheduleId;

  return {
    list: async (req, res) => {
      res.json({ data: await service.list(scopeOf(req, res)) });
    },
    get: async (req, res) => {
      res.json(await service.get(scopeOf(req, res), idOf(req, res)));
    },
    create: async (req, res) => {
      const { body } = inputOf<{ body: typeof createScheduleBody }>(req, res);
      res.status(201).json(await service.create(scopeOf(req, res), body));
    },
    update: async (req, res) => {
      const { body } = inputOf<{ body: typeof updateScheduleBody }>(req, res);
      res.json(await service.update(scopeOf(req, res), idOf(req, res), body));
    },
    remove: async (req, res) => {
      await service.delete(scopeOf(req, res), idOf(req, res));
      res.status(204).end();
    },
    addOverride: async (req, res) => {
      const { body } = inputOf<{ body: typeof createOverrideBody }>(req, res);
      res.status(201).json(await service.addOverride(scopeOf(req, res), idOf(req, res), body));
    },
    removeOverride: async (req, res) => {
      const { params } = inputOf<{ params: typeof overrideIdParams }>(req, res);
      await service.removeOverride(scopeOf(req, res), params.scheduleId, params.overrideId);
      res.status(204).end();
    },
    onCall: async (req, res) => {
      const { query } = inputOf<{ query: typeof onCallQuery }>(req, res);
      res.json(
        await service.onCall(
          scopeOf(req, res),
          idOf(req, res),
          query.at === undefined ? undefined : new Date(query.at),
        ),
      );
    },
    feed: async (req, res) => {
      res.json(await service.feed(scopeOf(req, res)));
    },
    rotateFeed: async (req, res) => {
      res.status(201).json(await service.rotateFeed(scopeOf(req, res)));
    },
    removeFeed: async (req, res) => {
      await service.removeFeed(scopeOf(req, res));
      res.status(204).end();
    },
    timeline: async (req, res) => {
      const { query } = inputOf<{ query: typeof timelineQuery }>(req, res);
      res.json({
        data: await service.timeline(
          scopeOf(req, res),
          idOf(req, res),
          new Date(query.from),
          new Date(query.to),
        ),
      });
    },
  };
}
