/*
 * requirePermission: what a workspace route needs (PRODUCT.md §6.11). The table of roles and
 * permissions is in @app/shared; the UI hides what a role can't do and this is where the API enforces
 * it. Every route under /api/w/:workspaceId carries exactly one of these guards (a test walks the
 * routers to check), so a new role or route can't slip through unguarded.
 */
import type { RequestHandler } from "express";
import { broadestRole, roleCan, type Permission } from "@app/shared";
import { ForbiddenError, NotFoundError } from "../core/errors.js";
import type { WorkspaceRole } from "../core/workspace-scope.js";
import "./context.js";

export function hasPermission(actual: WorkspaceRole | "system", permission: Permission): boolean {
  if (actual === "system") return true;
  return roleCan(actual, permission);
}

/* A guard that names its permission, so tests and tools can read what a route needs. */
export interface PermissionGuard extends RequestHandler {
  permission: Permission;
}

export function isPermissionGuard(handler: unknown): handler is PermissionGuard {
  return (
    typeof handler === "function" && typeof (handler as PermissionGuard).permission === "string"
  );
}

export function requirePermission(permission: Permission): PermissionGuard {
  const guard: RequestHandler = (_req, res, next) => {
    const scope = res.locals.scope;
    if (scope === undefined) {
      next(new NotFoundError("Workspace not found."));
      return;
    }
    if (!hasPermission(scope.role, permission)) {
      next(new ForbiddenError("Your role in this workspace doesn't allow this."));
      return;
    }
    next();
  };
  return Object.assign(guard, { permission });
}

/* Better Auth stores one or more roles as "admin,member"; the one that grants the most wins. */
export function parseMemberRole(value: string | null | undefined): WorkspaceRole | undefined {
  return broadestRole(value);
}
