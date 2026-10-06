/*
 * Auth service for the container: the Better Auth instance, its raw-body router (mounted before
 * express.json(), PRODUCT.md §7.9) and a session lookup for requireSession.
 */
import { Router } from "express";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import type { GetSession, SessionContext } from "../../core/session.js";
import { AUTH_BASE_PATH, createAuth, type Auth, type AuthOptions } from "./auth.js";

export { AUTH_BASE_PATH, createAuth, type Auth, type AuthOptions } from "./auth.js";
export { WORKSPACE_ROLES, isWorkspaceRole, type WorkspaceRoleName } from "./access.js";
export { createRedisRateLimitStorage } from "./rate-limit-storage.js";

export interface AuthService {
  auth: Auth;
  router: Router;
  getSession: GetSession;
}

export function createAuthService(options: AuthOptions): AuthService {
  const auth = createAuth(options);
  const handler = toNodeHandler(auth);
  const router = Router();
  router.all(`${AUTH_BASE_PATH}/{*path}`, (req, res) => {
    void handler(req, res);
  });

  const getSession: GetSession = async (headers) => {
    const result = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
    if (result === null) return null;
    const context: SessionContext = {
      userId: result.user.id,
      email: result.user.email,
      emailVerified: result.user.emailVerified,
      sessionId: result.session.id,
    };
    return context;
  };

  return { auth, router, getSession };
}
