/* HTTP in and out only; no business logic. */
import type { RequestHandler } from "express";
import { inputOf } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import type { AlertingService } from "./alerting.service.js";
import type {
  channelIdParams,
  createPolicyBody,
  incidentIdParams,
  policyIdParams,
  updatePolicyBody,
} from "./validators/index.js";

export type AlertingController = Record<
  "list" | "create" | "update" | "remove" | "sendTest" | "deliveries",
  RequestHandler
>;

export function createAlertingController(service: AlertingService): AlertingController {
  const idOf = (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) =>
    inputOf<{ params: typeof policyIdParams }>(req, res).params.policyId;

  return {
    list: async (req, res) => {
      res.json({ data: await service.listPolicies(scopeOf(req, res)) });
    },
    create: async (req, res) => {
      const { body } = inputOf<{ body: typeof createPolicyBody }>(req, res);
      res.status(201).json(await service.createPolicy(scopeOf(req, res), body));
    },
    update: async (req, res) => {
      const { body } = inputOf<{ body: typeof updatePolicyBody }>(req, res);
      res.json(await service.updatePolicy(scopeOf(req, res), idOf(req, res), body));
    },
    deliveries: async (req, res) => {
      const { params } = inputOf<{ params: typeof incidentIdParams }>(req, res);
      res.json({ data: await service.deliveryLog(scopeOf(req, res), params.incidentId) });
    },
    sendTest: async (req, res) => {
      const { params } = inputOf<{ params: typeof channelIdParams }>(req, res);
      res.json(await service.sendTest(scopeOf(req, res), params.channelId));
    },
    remove: async (req, res) => {
      await service.deletePolicy(scopeOf(req, res), idOf(req, res));
      res.status(204).end();
    },
  };
}
