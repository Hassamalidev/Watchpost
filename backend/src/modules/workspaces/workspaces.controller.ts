/* HTTP in and out only; no business logic. */
import type { RequestHandler } from "express";
import { sessionOf } from "../../middleware/session.js";
import { scopeOf } from "../../middleware/workspace.js";
import type { WorkspacesService } from "./workspaces.service.js";

export interface WorkspacesController {
  me: RequestHandler;
  members: RequestHandler;
}

export function createWorkspacesController(service: WorkspacesService): WorkspacesController {
  return {
    me: (req, res) => {
      res.json(service.me(scopeOf(req, res), sessionOf(req, res)));
    },
    members: async (req, res) => {
      res.json({ data: await service.listMembers(scopeOf(req, res)) });
    },
  };
}
