/*
 * Routes of the public API, `/api/v1` (PRODUCT.md §7.9). A module describes each route once: what
 * it needs (an API key scope), what it accepts and answers (Zod), and how to handle it. The
 * container mounts them all behind the same key check, rate limit and idempotency, and the OpenAPI
 * document is generated from the same descriptions, so the documentation can't drift from the code.
 */
import type { z } from "zod";
import type { ApiScope } from "@app/shared";
import type { WorkspaceScope } from "./workspace-scope.js";

/* The key a request was made with. */
export interface ApiKeyContext {
  id: string;
  name: string;
  scopes: ApiScope[];
  expiresAt: Date | null;
}

export type PublicMethod = "get" | "post" | "patch" | "put" | "delete";

export interface PublicRoute {
  method: PublicMethod;
  /* Express style, below /api/v1: "/monitors/:monitorId". */
  path: string;
  /* The scope a key needs; null for a route every valid key may call. */
  scope: ApiScope | null;
  /* The heading the route is listed under in the documentation. */
  tag: string;
  summary: string;
  description?: string;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  /* Status and shape of a successful answer; no schema means an empty answer. */
  status: number;
  response?: z.ZodType;
  handle(ctx: {
    scope: WorkspaceScope;
    key: ApiKeyContext;
    params: unknown;
    query: unknown;
    body: unknown;
  }): Promise<unknown>;
}

/*
 * Declares one route with its types checked: the handler gets the parsed params, query and body,
 * and what it returns has to fit the response schema.
 */
export function publicRoute<
  P extends z.ZodType = z.ZodUndefined,
  Q extends z.ZodType = z.ZodUndefined,
  B extends z.ZodType = z.ZodUndefined,
  R extends z.ZodType = z.ZodUndefined,
>(
  route: Omit<PublicRoute, "params" | "query" | "body" | "response" | "handle"> & {
    params?: P;
    query?: Q;
    body?: B;
    response?: R;
    handle(ctx: {
      scope: WorkspaceScope;
      key: ApiKeyContext;
      params: z.output<P>;
      query: z.output<Q>;
      body: z.output<B>;
    }): Promise<z.input<R>>;
  },
): PublicRoute {
  return route as unknown as PublicRoute;
}
