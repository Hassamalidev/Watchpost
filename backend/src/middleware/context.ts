/* Request-scoped values set by middleware, typed on Express's res.locals. */
import type { SessionContext } from "../core/session.js";
import type { WorkspaceScope } from "../core/workspace-scope.js";

declare module "express-serve-static-core" {
  interface Locals {
    session?: SessionContext;
    scope?: WorkspaceScope;
    /* Parsed request parts from validate(). */
    input?: Record<string, unknown>;
  }
}
