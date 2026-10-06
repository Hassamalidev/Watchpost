/*
 * requireSession: resolves the Better Auth session cookie. The lookup function comes from the
 * container (infra/auth), so this middleware never imports Better Auth or modules (§7.3).
 */
import type { Request, RequestHandler, Response } from "express";
import { UnauthorizedError } from "../core/errors.js";
import type { GetSession, SessionContext } from "../core/session.js";
import "./context.js";

export type { GetSession } from "../core/session.js";

export function requireSession(getSession: GetSession): RequestHandler {
  return async (req, res, next) => {
    const session = await getSession(req.headers);
    if (session === null) {
      next(new UnauthorizedError());
      return;
    }
    res.locals.session = session;
    next();
  };
}

/* For handlers behind requireSession. */
export function sessionOf(_req: Request, res: Response): SessionContext {
  const session = res.locals.session;
  if (session === undefined) throw new UnauthorizedError();
  return session;
}
