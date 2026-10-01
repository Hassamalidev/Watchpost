/* HTTP in and out only; no business logic. */
import type { RequestHandler } from "express";
import { sessionOf } from "../../middleware/session.js";
import { inputOf } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import type { BillingService } from "./billing.service.js";
import type { buyCreditsBody, cancelBody, planBody } from "./validators/index.js";

export interface BillingController {
  entitlements: RequestHandler;
  state: RequestHandler;
  checkout: RequestHandler;
  changePlan: RequestHandler;
  buyCredits: RequestHandler;
  cancel: RequestHandler;
  pause: RequestHandler;
  resume: RequestHandler;
  portal: RequestHandler;
}

export function createBillingController(service: BillingService): BillingController {
  return {
    entitlements: async (req, res) => {
      res.json(await service.entitlements(scopeOf(req, res)));
    },
    state: async (req, res) => {
      res.json(await service.state(scopeOf(req, res)));
    },
    checkout: async (req, res) => {
      const { body } = inputOf<{ body: typeof planBody }>(req, res);
      res.json(await service.checkout(scopeOf(req, res), sessionOf(req, res), body));
    },
    changePlan: async (req, res) => {
      const { body } = inputOf<{ body: typeof planBody }>(req, res);
      res.json(await service.changePlan(scopeOf(req, res), body));
    },
    buyCredits: async (req, res) => {
      const { body } = inputOf<{ body: typeof buyCreditsBody }>(req, res);
      await service.buyCredits(scopeOf(req, res), body.credits);
      res.status(202).json({ status: "charging" });
    },
    cancel: async (req, res) => {
      const { body } = inputOf<{ body: typeof cancelBody }>(req, res);
      res.json(await service.cancel(scopeOf(req, res), body));
    },
    pause: async (req, res) => {
      res.json(await service.pause(scopeOf(req, res)));
    },
    resume: async (req, res) => {
      res.json(await service.resume(scopeOf(req, res)));
    },
    portal: async (req, res) => {
      res.json(await service.portal(scopeOf(req, res)));
    },
  };
}
