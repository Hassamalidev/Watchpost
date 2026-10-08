/* Request-scoped values set by middleware, typed on Express's res.locals. */
import type { ApiKeyContext } from "../core/public-api.js";
import type { SessionContext } from "../core/session.js";
import type { WorkspaceScope } from "../core/workspace-scope.js";

declare module "express-serve-static-core" {
  interface Locals {
    session?: SessionContext;
    scope?: WorkspaceScope;
    /* The API key a /api/v1 request was made with. */
    apiKey?: ApiKeyContext;
    /* Parsed request parts from validate(). */
    input?: Record<string, unknown>;
  }
}
