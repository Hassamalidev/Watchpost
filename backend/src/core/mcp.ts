/*
 * The MCP server (PRODUCT.md §6.13): AI assistants call a few of the public API's routes as tools.
 * This file is the protocol, with nothing about HTTP or keys in it: JSON-RPC 2.0 messages in, JSON-RPC
 * answers out (Model Context Protocol, "tools" only). A tool is a public route that names itself
 * one, so a tool takes exactly what its route takes and answers exactly what its route answers.
 */
import { z } from "zod";
import { AppError } from "./errors.js";
import type { PublicRoute } from "./public-api.js";

/* Newest first. We answer with the client's version when we know it, else with our newest. */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

type Json = Record<string, unknown>;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Json;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
  };
  route: PublicRoute;
}

const PARTS = ["params", "query", "body"] as const;

function objectSchema(schema: z.ZodType): { properties: Record<string, Json>; required: string[] } {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Json;
  return {
    properties: (json.properties ?? {}) as Record<string, Json>,
    required: (json.required ?? []) as string[],
  };
}

/* The routes that are tools, each with one flat input: path, query and body fields side by side. */
export function mcpToolsOf(routes: readonly PublicRoute[]): McpTool[] {
  return routes.flatMap((route) => {
    if (route.tool === undefined) return [];
    const properties: Record<string, Json> = {};
    const required: string[] = [];
    for (const part of PARTS) {
      const schema = route[part];
      if (schema === undefined) continue;
      const fields = objectSchema(schema);
      Object.assign(properties, fields.properties);
      /* Every path field is needed, whatever its schema says. */
      required.push(...(part === "params" ? Object.keys(fields.properties) : fields.required));
    }
    return [
      {
        name: route.tool.name,
        description: route.tool.description,
        inputSchema: {
          type: "object",
          properties,
          ...(required.length > 0 ? { required: [...new Set(required)] } : {}),
          additionalProperties: false,
        },
        annotations: {
          title: route.summary,
          readOnlyHint: route.method === "get",
          destructiveHint: route.method === "delete",
          /* Asking twice changes nothing more: true for reads and for the "set to this" writes. */
          idempotentHint: route.method !== "post" || route.tool.idempotent === true,
        },
        route,
      },
    ];
  });
}

/* A tool's arguments, sorted back into what its route takes. Throws a ZodError for bad input. */
export function routeInputOf(
  tool: McpTool,
  args: Json,
): { params: unknown; query: unknown; body: unknown } {
  const known = new Set(Object.keys(tool.inputSchema.properties as Json));
  const unknown = Object.keys(args).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new z.ZodError([
      {
        code: "custom",
        path: [unknown[0] ?? ""],
        message: "is not an argument of this tool",
        input: args,
      },
    ]);
  }
  const input: { params: unknown; query: unknown; body: unknown } = {
    params: undefined,
    query: undefined,
    body: undefined,
  };
  for (const part of PARTS) {
    const schema = tool.route[part];
    if (schema === undefined) continue;
    const fields = Object.keys(objectSchema(schema).properties);
    const picked = Object.fromEntries(
      fields.flatMap((field) => {
        const value = args[field];
        if (value === undefined) return [];
        /* Paths and query strings are text over HTTP, and their schemas expect text. */
        const text = part !== "body" && (typeof value === "number" || typeof value === "boolean");
        return [[field, text ? String(value) : value]];
      }),
    );
    input[part] = schema.parse(picked);
  }
  return input;
}

export interface McpContext {
  serverInfo: { name: string; version: string };
  instructions: string;
  /* The tools this caller may see and call. */
  tools: McpTool[];
  /* Runs a tool whose input is already checked; throws AppError for refusals. */
  call(tool: McpTool, input: { params: unknown; query: unknown; body: unknown }): Promise<unknown>;
}

const rpcMessage = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const result = (id: string | number, value: Json) => ({
  jsonrpc: "2.0" as const,
  id,
  result: value,
});
const failure = (id: string | number | null, code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  id,
  error: { code, message },
});
/* A tool that didn't work answers normally with `isError`, so the model can read why and react. */
const toolText = (text: string, isError = false) => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

/* One message in, its answer out; undefined for a notification, which gets no answer. */
export async function handleMcpMessage(raw: unknown, ctx: McpContext): Promise<Json | undefined> {
  if (Array.isArray(raw))
    return failure(null, -32600, "Send one message per request; batches aren't supported.");
  const parsed = rpcMessage.safeParse(raw);
  if (!parsed.success) return failure(null, -32600, "Not a JSON-RPC 2.0 message.");
  const { id, method, params } = parsed.data;
  if (id === undefined) return undefined;

  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      const version = (MCP_PROTOCOL_VERSIONS as readonly unknown[]).includes(asked)
        ? (asked as string)
        : MCP_PROTOCOL_VERSIONS[0];
      return result(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: ctx.serverInfo,
        instructions: ctx.instructions,
      });
    }
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, {
        tools: ctx.tools.map(({ name, description, inputSchema, annotations }) => ({
          name,
          description,
          inputSchema,
          annotations,
        })),
      });
    case "tools/call": {
      const tool = ctx.tools.find((t) => t.name === params?.name);
      if (tool === undefined) return failure(id, -32602, `Unknown tool: ${String(params?.name)}`);
      const args = params?.arguments ?? {};
      if (args === null || typeof args !== "object" || Array.isArray(args)) {
        return failure(id, -32602, "`arguments` must be an object.");
      }
      try {
        const answer = await ctx.call(tool, routeInputOf(tool, args as Json));
        return result(
          id,
          toolText(answer === undefined ? "Done." : JSON.stringify(answer, null, 2)),
        );
      } catch (err) {
        if (err instanceof z.ZodError) {
          const problems = err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`);
          return result(id, toolText(`Invalid arguments. ${problems.join("; ")}`, true));
        }
        if (err instanceof AppError && err.status < 500)
          return result(id, toolText(err.message, true));
        throw err;
      }
    }
    default:
      return failure(id, -32601, `Method not found: ${method}`);
  }
}
