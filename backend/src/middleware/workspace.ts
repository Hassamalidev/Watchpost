/*
 * requireWorkspace: turns `:workspaceId` plus the session into a WorkspaceScope (PRODUCT.md §7.9 step 7).
 * Non-members get 404, not 403, so workspace IDs cannot be probed.
 * The membership lookup comes from the workspaces module via the container.
 */
import type { Request, RequestHandler, Response } from "express";
import { NotFoundError, UnauthorizedError } from "../core/errors.js";
import "./context.js";
import {
  createWorkspaceScope,
  type WorkspaceRole,
  type WorkspaceScope,
} from "../core/workspace-scope.js";

export type ResolveRole = (
  userId: string,
  workspaceId: string,
) => Promise<WorkspaceRole | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireWorkspace(resolveRole: ResolveRole, param = "workspaceId"): RequestHandler {
  return async (req, res, next) => {
    const session = res.locals.session;
    if (session === undefined) {
      next(new UnauthorizedError());
      return;
    }
    const workspaceId = req.params[param];
    if (typeof workspaceId !== "string" || !UUID.test(workspaceId)) {
      next(new NotFoundError("Workspace not found."));
      return;
    }
    const role = await resolveRole(session.userId, workspaceId.toLowerCase());
    if (role === undefined) {
      next(new NotFoundError("Workspace not found."));
      return;
    }
    res.locals.scope = createWorkspaceScope({ workspaceId, actorUserId: session.userId, role });
    next();
  };
}

/* For handlers behind requireWorkspace. */
export function scopeOf(_req: Request, res: Response): WorkspaceScope {
  const scope = res.locals.scope;
  if (scope === undefined) throw new NotFoundError("Workspace not found.");
  return scope;
}
