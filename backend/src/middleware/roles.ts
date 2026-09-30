/*
 * requireRole: minimum workspace role for a route (PRODUCT.md §6.11). The UI hides what a role
 * can't do; this is where the API enforces it. Responder and billing (P4-T01) are placed so that
 * neither passes a member-level check; billing gets its own routes later.
 */
import type { RequestHandler } from "express";
import { ForbiddenError, NotFoundError } from "../core/errors.js";
import type { WorkspaceRole } from "../core/workspace-scope.js";
import "./context.js";

export const ROLE_RANK: Record<WorkspaceRole, number> = {
  billing: 0,
  viewer: 1,
  responder: 2,
  member: 3,
  admin: 4,
  owner: 5,
};

export function hasRole(actual: WorkspaceRole | "system", minimum: WorkspaceRole): boolean {
  if (actual === "system") return true;
  return ROLE_RANK[actual] >= ROLE_RANK[minimum];
}

export function requireRole(minimum: WorkspaceRole): RequestHandler {
  return (_req, res, next) => {
    const scope = res.locals.scope;
    if (scope === undefined) {
      next(new NotFoundError("Workspace not found."));
      return;
    }
    if (!hasRole(scope.role, minimum)) {
      next(new ForbiddenError(`This needs the ${minimum} role or higher.`));
      return;
    }
    next();
  };
}

/* Better Auth stores one or more roles as "admin,member"; the highest known role wins. */
export function parseMemberRole(value: string | null | undefined): WorkspaceRole | undefined {
  let best: WorkspaceRole | undefined;
  for (const raw of (value ?? "").split(",")) {
    const role = raw.trim() as WorkspaceRole;
    if (!(role in ROLE_RANK)) continue;
    if (best === undefined || ROLE_RANK[role] > ROLE_RANK[best]) best = role;
  }
  return best;
}
