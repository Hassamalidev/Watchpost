/*
 * The OpenAPI 3.1 document for `/api/v1`, generated from the route descriptions (PRODUCT.md §7.9:
 * "OpenAPI generated from Zod"). Pure: the same routes in, the same document out.
 */
import { z } from "zod";
import {
  API_RATE_LIMIT_PER_MINUTE,
  IDEMPOTENCY_KEY_HOURS,
  problemSchema,
  type ApiScope,
} from "@app/shared";
import type { PublicRoute } from "./public-api.js";

type Json = Record<string, unknown>;

/* What callers send (`input`) or what we answer (`output`), as JSON Schema without the meta key. */
function jsonSchema(schema: z.ZodType, io: "input" | "output"): Json {
  const { $schema: _meta, ...rest } = z.toJSONSchema(schema, {
    io,
    unrepresentable: "any",
  }) as Json;
  return rest;
}

/* "/monitors/:monitorId" → "/monitors/{monitorId}" */
const openApiPath = (path: string) => path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

function parameters(route: PublicRoute): Json[] {
  const list: Json[] = [];
  for (const [where, schema] of [
    ["path", route.params],
    ["query", route.query],
  ] as const) {
    if (schema === undefined) continue;
    const json = jsonSchema(schema, "input");
    const properties = (json.properties ?? {}) as Record<string, Json>;
    const required = (json.required ?? []) as string[];
    for (const [name, property] of Object.entries(properties)) {
      const { description, ...rest } = property;
      list.push({
        name,
        in: where,
        required: where === "path" || required.includes(name),
        ...(typeof description === "string" ? { description } : {}),
        schema: rest,
      });
    }
  }
  if (route.method !== "get") {
    list.push({
      name: "Idempotency-Key",
      in: "header",
      required: false,
      description: `Any unique text, up to 200 characters. Sending the same key again within ${IDEMPOTENCY_KEY_HOURS} hours returns the first answer instead of doing the work twice.`,
      schema: { type: "string", maxLength: 200 },
    });
  }
  return list;
}

const problem = (description: string): Json => ({
  description,
  content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
});

function operation(route: PublicRoute): Json {
  const scope: ApiScope | null = route.scope;
  const writes = route.method !== "get";
  return {
    operationId: `${route.method}${route.path.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ?? "").toUpperCase())}`,
    tags: [route.tag],
    summary: route.summary,
    description: [
      route.description ?? "",
      scope === null ? "Any valid key may call this." : `Needs the \`${scope}\` scope.`,
    ]
      .filter((line) => line !== "")
      .join("\n\n"),
    parameters: parameters(route),
    ...(route.body === undefined
      ? {}
      : {
          requestBody: {
            required: true,
            content: { "application/json": { schema: jsonSchema(route.body, "input") } },
          },
        }),
    responses: {
      [String(route.status)]:
        route.text !== undefined
          ? {
              description: route.text.description,
              content: { "text/plain": { schema: { type: "string" } } },
            }
          : route.response === undefined
            ? { description: "Done. The answer has no body." }
            : {
                description: "OK",
                content: {
                  "application/json": { schema: jsonSchema(route.response, "output") },
                },
              },
      ...(route.params || route.query || route.body
        ? { "400": problem("The request is invalid (`validation_failed`).") }
        : {}),
      "401": problem("The key is missing, wrong, revoked or expired (`unauthorized`)."),
      ...(writes ? { "402": problem("The plan doesn't include this (`quota_exceeded`).") } : {}),
      ...(scope === null ? {} : { "403": problem("The key lacks the scope (`forbidden`).") }),
      ...(route.params
        ? { "404": problem("There is no such thing in the workspace (`not_found`).") }
        : {}),
      ...(writes
        ? { "409": problem("The request conflicts with the current state (`conflict`).") }
        : {}),
      "429": problem("Too many requests (`rate_limited`). `Retry-After` says when to try again."),
    },
  };
}

export function buildOpenApi(
  routes: readonly PublicRoute[],
  info: { title: string; serverUrl: string },
): Json {
  const paths: Record<string, Json> = {};
  for (const route of routes) {
    const path = openApiPath(route.path);
    paths[path] = { ...(paths[path] ?? {}), [route.method]: operation(route) };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: info.title,
      version: "1",
      description: [
        "Send your API key with every request: `Authorization: Bearer <key>`. Keys are made in Settings → API keys; each belongs to one workspace and carries the scopes you gave it. A write scope includes reading.",
        `Each key may make ${API_RATE_LIMIT_PER_MINUTE} requests a minute; the \`RateLimit\` header says what is left.`,
        "Lists are paged: pass `limit` and the `nextCursor` of the answer before as `cursor`.",
        "Errors are problem documents (RFC 9457) with a stable `code`.",
      ].join("\n\n"),
    },
    servers: [{ url: `${info.serverUrl}/api/v1` }],
    security: [{ apiKey: [] }],
    tags: [...new Set(routes.map((r) => r.tag))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: { apiKey: { type: "http", scheme: "bearer" } },
      schemas: { Problem: jsonSchema(problemSchema, "output") },
    },
  };
}
