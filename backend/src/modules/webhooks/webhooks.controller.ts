/* HTTP in and out only; no business logic. */
import type { RequestHandler } from "express";
import { webhookCatalog } from "@app/shared";
import { inputOf } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import type { WebhooksService } from "./webhooks.service.js";
import type {
  createWebhookBody,
  deliveriesQuery,
  deliveryParams,
  testWebhookBody,
  updateWebhookBody,
  webhookIdParams,
} from "./validators/index.js";

export type WebhooksController = Record<
  | "catalog"
  | "list"
  | "create"
  | "update"
  | "remove"
  | "rotateSecret"
  | "deliveries"
  | "test"
  | "replay",
  RequestHandler
>;

export function createWebhooksController(service: WebhooksService): WebhooksController {
  type Req = Parameters<RequestHandler>[0];
  type Res = Parameters<RequestHandler>[1];
  const idOf = (req: Req, res: Res) =>
    inputOf<{ params: typeof webhookIdParams }>(req, res).params.webhookId;
  return {
    catalog: (_req, res) => {
      res.json({ data: webhookCatalog() });
    },
    list: async (req, res) => {
      res.json({ data: await service.list(scopeOf(req, res)) });
    },
    create: async (req, res) => {
      const { body } = inputOf<{ body: typeof createWebhookBody }>(req, res);
      /* The answer holds the signing secret, so nothing on the way may keep a copy. */
      res
        .status(201)
        .set("cache-control", "no-store")
        .json(await service.create(scopeOf(req, res), body));
    },
    update: async (req, res) => {
      const { body } = inputOf<{ body: typeof updateWebhookBody }>(req, res);
      res.json(await service.update(scopeOf(req, res), idOf(req, res), body));
    },
    remove: async (req, res) => {
      await service.remove(scopeOf(req, res), idOf(req, res));
      res.status(204).end();
    },
    rotateSecret: async (req, res) => {
      res
        .set("cache-control", "no-store")
        .json(await service.rotateSecret(scopeOf(req, res), idOf(req, res)));
    },
    deliveries: async (req, res) => {
      const { query } = inputOf<{ query: typeof deliveriesQuery }>(req, res);
      res.json({
        data: await service.deliveries(scopeOf(req, res), idOf(req, res), query.limit),
      });
    },
    test: async (req, res) => {
      const { body } = inputOf<{ body: typeof testWebhookBody }>(req, res);
      res.json(await service.test(scopeOf(req, res), idOf(req, res), body.type));
    },
    replay: async (req, res) => {
      const { params } = inputOf<{ params: typeof deliveryParams }>(req, res);
      res.json(await service.replay(scopeOf(req, res), params.webhookId, params.deliveryId));
    },
  };
}
