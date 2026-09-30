/* HTTP in and out only; no business logic. */
import type { RequestHandler } from "express";
import { inputOf } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import type { ChannelsService } from "./channels.service.js";
import type { channelIdParams, createChannelBody, updateChannelBody } from "./validators/index.js";

export type ChannelsController = Record<
  "list" | "get" | "create" | "update" | "remove",
  RequestHandler
>;

export function createChannelsController(service: ChannelsService): ChannelsController {
  const idOf = (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) =>
    inputOf<{ params: typeof channelIdParams }>(req, res).params.channelId;

  return {
    list: async (req, res) => {
      res.json({ data: await service.list(scopeOf(req, res)) });
    },
    get: async (req, res) => {
      res.json(await service.get(scopeOf(req, res), idOf(req, res)));
    },
    create: async (req, res) => {
      const { body } = inputOf<{ body: typeof createChannelBody }>(req, res);
      res.status(201).json(await service.create(scopeOf(req, res), body));
    },
    update: async (req, res) => {
      const { body } = inputOf<{ body: typeof updateChannelBody }>(req, res);
      res.json(await service.update(scopeOf(req, res), idOf(req, res), body));
    },
    remove: async (req, res) => {
      await service.delete(scopeOf(req, res), idOf(req, res));
      res.status(204).end();
    },
  };
}
