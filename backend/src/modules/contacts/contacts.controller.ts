/* HTTP in and out only; no business logic. */
import type { RequestHandler } from "express";
import { inputOf } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import type { ContactsService } from "./contacts.service.js";
import type {
  confirmBody,
  createMethodBody,
  methodIdParams,
  replaceRulesBody,
  urgencyParams,
} from "./validators/index.js";

export type ContactsController = Record<
  "list" | "add" | "remove" | "requestCode" | "confirm" | "rules" | "replaceRules",
  RequestHandler
>;

export function createContactsController(service: ContactsService): ContactsController {
  const idOf = (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) =>
    inputOf<{ params: typeof methodIdParams }>(req, res).params.methodId;

  return {
    list: async (req, res) => {
      res.json({ data: await service.listMethods(scopeOf(req, res)) });
    },
    add: async (req, res) => {
      const { body } = inputOf<{ body: typeof createMethodBody }>(req, res);
      res.status(201).json(await service.addMethod(scopeOf(req, res), body));
    },
    remove: async (req, res) => {
      await service.removeMethod(scopeOf(req, res), idOf(req, res));
      res.status(204).end();
    },
    requestCode: async (req, res) => {
      res.status(201).json(await service.requestCode(scopeOf(req, res), idOf(req, res)));
    },
    confirm: async (req, res) => {
      const { body } = inputOf<{ body: typeof confirmBody }>(req, res);
      res.json(await service.confirm(scopeOf(req, res), idOf(req, res), body.code));
    },
    rules: async (req, res) => {
      res.json(await service.rules(scopeOf(req, res)));
    },
    replaceRules: async (req, res) => {
      const { params, body } = inputOf<{
        params: typeof urgencyParams;
        body: typeof replaceRulesBody;
      }>(req, res);
      res.json(await service.replaceRules(scopeOf(req, res), params.urgency, body.rules));
    },
  };
}
