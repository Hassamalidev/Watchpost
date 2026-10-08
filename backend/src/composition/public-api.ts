/*
 * /api/v1, the public API (PRODUCT.md §7.9): every module's public routes behind the same four
 * steps (key, rate limit per key, scope, idempotency for writes), then validation and the handler.
 * What a handler returns is passed through the route's response schema, so an answer never carries
 * a field the documentation doesn't list. `/api/v1/openapi.json` describes it all and needs no key.
 */
import { Router, type RequestHandler } from "express";
import { buildOpenApi } from "../core/openapi.js";
import type { PublicRoute } from "../core/public-api.js";
import { UnauthorizedError } from "../core/errors.js";
import "../middleware/context.js";
import { inputOf, validate } from "../middleware/validate.js";
import type { AppModule, MountedRouter } from "./types.js";

export const PUBLIC_API_PREFIX = "/api/v1";

function handlerOf(route: PublicRoute): RequestHandler {
  return async (req, res) => {
    const scope = res.locals.scope;
    const key = res.locals.apiKey;
    if (scope === undefined || key === undefined) throw new UnauthorizedError();
    const input = inputOf<{ params: never; query: never; body: never }>(req, res);
    const result = await route.handle({
      scope,
      key,
      params: input.params,
      query: input.query,
      body: input.body,
    });
    if (route.response === undefined) {
      res.status(route.status).end();
      return;
    }
    res.status(route.status).json(route.response.parse(result));
  };
}

export function publicRoutesOf(modules: AppModule[]): PublicRoute[] {
  return modules.flatMap((m) => m.publicRoutes ?? []);
}

export function publicApi(
  modules: AppModule[],
  info: { title: string; serverUrl: string },
): MountedRouter[] {
  const guards = modules.find((m) => m.publicApiGuards)?.publicApiGuards;
  const routes = publicRoutesOf(modules);
  if (guards === undefined || routes.length === 0) return [];
  const router = Router();
  const document = buildOpenApi(routes, info);
  router.get("/openapi.json", (_req, res) => {
    res.set("cache-control", "public, max-age=300").json(document);
  });
  router.use(guards.authenticate, guards.rateLimit);
  for (const route of routes) {
    router[route.method](
      route.path,
      ...(route.scope === null ? [] : [guards.requireScope(route.scope)]),
      validate({
        ...(route.params ? { params: route.params } : {}),
        ...(route.query ? { query: route.query } : {}),
        ...(route.body ? { body: route.body } : {}),
      }),
      ...(route.method === "get" ? [] : [guards.idempotent]),
      handlerOf(route),
    );
  }
  return [{ path: PUBLIC_API_PREFIX, router }];
}
