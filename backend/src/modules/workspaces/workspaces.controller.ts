/* HTTP in and out only; no business logic. */
import type { RequestHandler } from "express";
import { sessionOf } from "../../middleware/session.js";
import { inputOf } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import type { updateSettingsBody } from "./validators/index.js";
import type { WorkspacesService } from "./workspaces.service.js";

export interface WorkspacesController {
  me: RequestHandler;
  members: RequestHandler;
  getSettings: RequestHandler;
  updateSettings: RequestHandler;
}

export function createWorkspacesController(service: WorkspacesService): WorkspacesController {
  return {
    me: async (req, res) => {
      res.json(await service.me(scopeOf(req, res), sessionOf(req, res)));
    },
    members: async (req, res) => {
      res.json({ data: await service.listMembers(scopeOf(req, res)) });
    },
    getSettings: async (req, res) => {
      res.json(await service.getSettings(scopeOf(req, res)));
    },
    updateSettings: async (req, res) => {
      const { body } = inputOf<{ body: typeof updateSettingsBody }>(req, res);
      res.json(await service.updateSettings(scopeOf(req, res), body, sessionOf(req, res)));
    },
  };
}
