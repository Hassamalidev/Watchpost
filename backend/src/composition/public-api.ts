/*
 * /api/v1, the public API (PRODUCT.md §7.9): every module's public routes behind the same four
 * steps (key, rate limit per key, scope, idempotency for writes), then validation and the handler.
 * What a handler returns is passed through the route's response schema, so an answer never carries
 * a field the documentation doesn't list. `/api/v1/openapi.json` describes it all and needs no key.
 */
import { Router, type RequestHandler } from "express";
import { scopeAllows } from "@app/shared";
import { handleMcpMessage, mcpToolsOf } from "../core/mcp.js";
import { buildOpenApi } from "../core/openapi.js";
import type { PublicRoute } from "../core/public-api.js";
import { UnauthorizedError } from "../core/errors.js";
import "../middleware/context.js";
import { inputOf, validate } from "../middleware/validate.js";
import type { AppModule, MountedRouter } from "./types.js";

export const PUBLIC_API_PREFIX = "/api/v1";

/* Told to the assistant once, when it connects. */
const MCP_INSTRUCTIONS = [
  "These tools read and act on one workspace of an uptime monitoring and on-call service.",
  'Use list_incidents with status "open" to see what is wrong now, and get_incident for one incident.',
  "An incident can be addressed by its number (12 for #12) or its ID.",
  "Acknowledging stops escalation: do it only when the person you are helping asks for it or says they are handling the incident.",
  "A maintenance window silences alerts for its monitors while it is in effect: create one only for a period the person names.",
  "Times are ISO 8601 in UTC.",
].join(" ");

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

  /*
   * The MCP server: one address AI assistants post JSON-RPC messages to, with the same key. Every
   * answer is a single JSON document; we open no event stream, so GET is refused.
   */
  const tools = mcpToolsOf(routes);
  router.post("/mcp", async (req, res) => {
    const scope = res.locals.scope;
    const key = res.locals.apiKey;
    if (scope === undefined || key === undefined) throw new UnauthorizedError();
    const answer = await handleMcpMessage(req.body, {
      serverInfo: { name: info.title, version: "1" },
      instructions: MCP_INSTRUCTIONS,
      /* A key is shown the tools its scopes allow (a write scope includes reading). */
      tools: tools.filter(
        (tool) => tool.route.scope === null || scopeAllows(key.scopes, tool.route.scope),
      ),
      async call(tool, input) {
        const { route } = tool;
        if (route.scope !== null) await guards.assertScope(key, scope, route.scope);
        const result = await route.handle({ scope, key, ...input });
        return route.response === undefined ? undefined : route.response.parse(result);
      },
    });
    if (answer === undefined) {
      res.status(202).end();
      return;
    }
    res.json(answer);
  });
  router.all("/mcp", (_req, res) => {
    res
      .set("allow", "POST")
      .status(405)
      .json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Post JSON-RPC messages to this address." },
      });
  });
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
