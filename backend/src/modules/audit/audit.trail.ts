/*
 * The audit trail: one middleware in front of the app's API (/api/w/:workspaceId) and the public
 * API (/api/v1). It does nothing on the way in. When an answer has gone out, and the request
 * changed something (not a GET, answered 2xx) inside a workspace, it writes an entry: who (the
 * signed-in user or the API key), what (from the method and the matched route), to which thing
 * (the last ID in the path) and its name when the request carried one.
 *
 * Because it reads the route that matched, a new route is audited the day it is added, and the
 * request body is never stored: only a `name` or `title` from it, which are not secrets.
 */
import type { Request, RequestHandler, Response } from "express";
import { auditActionOf, auditCategoryOf } from "@app/shared";
import "../../middleware/context.js";
import type { AuditService } from "./audit.service.js";

/* A name to recognise the thing by, from where our request bodies put names. */
function nameIn(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  const settings = record.settings as Record<string, unknown> | undefined;
  for (const candidate of [record.name, settings?.name, record.title]) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
  }
  return undefined;
}

/* The ID the route is about: the last path parameter, which is the most specific one. */
function targetIn(req: Request): string | undefined {
  const values = Object.entries(req.params)
    .filter(([key]) => key !== "workspaceId")
    .map(([, value]) => value)
    .filter((value): value is string => typeof value === "string");
  return values.at(-1);
}

export function createAuditTrail(service: Pick<AuditService, "record">): RequestHandler {
  return (req: Request, res: Response, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      next();
      return;
    }
    res.on("finish", () => {
      const scope = res.locals.scope;
      const route = (req.route as { path?: unknown } | undefined)?.path;
      if (scope === undefined || typeof route !== "string") return;
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      const action = auditActionOf(req.method, route);
      if (action === undefined) return;
      const key = res.locals.apiKey;
      const session = res.locals.session;
      void service.record({
        workspaceId: scope.workspaceId,
        category: auditCategoryOf(action.split(".")[0] ?? ""),
        action,
        actor:
          key !== undefined
            ? { type: "api_key", id: key.id, label: `API key: ${key.name}` }
            : session !== undefined
              ? { type: "user", id: session.userId, label: session.email }
              : { type: "system", label: "System" },
        targetId: targetIn(req),
        detail: nameIn(req.body),
        ip: req.ip,
      });
    });
    next();
  };
}
