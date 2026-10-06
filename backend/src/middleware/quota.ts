/*
 * requireFeature: gates a route on a plan feature (PRODUCT.md §11 "Entitlements"). The lookup comes
 * from the billing module through the container, so this middleware never imports modules (§7.3).
 * Counted limits (monitors, members) are enforced inside the owning service's transaction instead,
 * where the count and the insert can't race.
 */
import type { RequestHandler } from "express";
import type { PlanFeature } from "@app/shared";
import { NotFoundError, QuotaExceededError } from "../core/errors.js";
import type { WorkspaceScope } from "../core/workspace-scope.js";
import "./context.js";

export type HasFeature = (scope: WorkspaceScope, feature: PlanFeature) => Promise<boolean>;

export function createQuotaGuard(hasFeature: HasFeature) {
  return function requireFeature(feature: PlanFeature, message: string): RequestHandler {
    return async (_req, res, next) => {
      const scope = res.locals.scope;
      if (scope === undefined) {
        next(new NotFoundError("Workspace not found."));
        return;
      }
      if (!(await hasFeature(scope, feature))) {
        next(new QuotaExceededError(message));
        return;
      }
      next();
    };
  };
}

export type RequireFeature = ReturnType<typeof createQuotaGuard>;
