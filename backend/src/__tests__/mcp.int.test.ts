/*
 * P6-T04 through the real app: an AI assistant connects to /api/v1/mcp with an API key, sees the
 * tools its key allows, reads monitors and incidents, acknowledges an incident and creates a
 * maintenance window. Refusals come back as tool errors it can read; the key's scopes and the
 * plan hold exactly as they do for the API.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import type { ApiScope } from "@app/shared";
import { createFakeClock } from "../core/clock.js";
import { WEB_ORIGIN, buildContainerApp, signUpVerified } from "./helpers/container-app.js";

const DAY = 86_400_000;
const clock = createFakeClock(new Date());
const ctx = buildContainerApp({ authRateLimit: false, clock });
const run = randomBytes(4).toString("hex");
let owner: TestAgent;
let ws = "";
let reader = "";
let writer = "";
let monitorId = "";
let incidentNumber = 0;
let nextId = 1;

const session = (method: "get" | "post", path: string) =>
  owner[method](`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN);

async function makeKey(scopes: ApiScope[]): Promise<string> {
  const res = await session("post", "/api-keys").send({ name: scopes.join(" "), scopes });
  expect(res.status, res.text).toBe(201);
  return res.body.key as string;
}

/* One JSON-RPC request, as an MCP client sends it. */
async function rpc(key: string, method: string, params?: Record<string, unknown>) {
  const res = await request(ctx.app)
    .post("/api/v1/mcp")
    .set("Authorization", `Bearer ${key}`)
    .set("Accept", "application/json, text/event-stream")
    .send({ jsonrpc: "2.0", id: nextId++, method, ...(params === undefined ? {} : { params }) });
  expect(res.status, res.text).toBe(200);
  return res.body as {
    id: number;
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };
}

interface ToolAnswer {
  isError: boolean;
  text: string;
  data: unknown;
}
async function call(
  key: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolAnswer> {
  const answer = await rpc(key, "tools/call", { name, arguments: args });
  expect(answer.error, JSON.stringify(answer.error)).toBeUndefined();
  const content = answer.result?.content as Array<{ type: string; text: string }>;
  const text = content[0]?.text ?? "";
  const isError = answer.result?.isError === true;
  return { isError, text, data: isError || !text.startsWith("{") ? undefined : JSON.parse(text) };
}

beforeAll(async () => {
  owner = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `mcp-${run}@example.com`);
  const created = await owner
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "MCP Co", slug: `mcp-${run}` });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id as string;
  reader = await makeKey(["monitors:read", "incidents:read"]);
  writer = await makeKey(["monitors:read", "incidents:write", "maintenance:write"]);
  const monitor = await session("post", "/monitors").send({
    settings: { name: "Checkout API" },
    config: { type: "tcp", host: "example.com", port: 443 },
  });
  monitorId = monitor.body.id as string;
  const incident = await session("post", "/incidents").send({
    title: "Checkout is down",
    severity: "critical",
    monitorId,
  });
  incidentNumber = incident.body.number as number;
}, 120_000);

afterAll(async () => {
  await ctx.container.close();
});

describe("the MCP server", () => {
  it("needs a key, and answers only to POST", async () => {
    const none = await request(ctx.app)
      .post("/api/v1/mcp")
      .send({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(none.status).toBe(401);
    const get = await request(ctx.app).get("/api/v1/mcp").set("Authorization", `Bearer ${reader}`);
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe("POST");
  });

  it("introduces itself and agrees a protocol version", async () => {
    const hello = await rpc(reader, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(hello.result).toMatchObject({
      protocolVersion: "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "Public API", version: "1" },
    });
    expect(hello.result?.instructions).toContain("list_incidents");
    /* A version we don't know gets our newest. */
    const newer = await rpc(reader, "initialize", { protocolVersion: "2099-01-01" });
    expect(newer.result?.protocolVersion).toBe("2025-06-18");

    /* A notification gets no answer. */
    const notified = await request(ctx.app)
      .post("/api/v1/mcp")
      .set("Authorization", `Bearer ${reader}`)
      .send({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notified.status).toBe(202);
    expect(notified.text).toBe("");
    expect((await rpc(reader, "ping")).result).toEqual({});
  });

  it("refuses what isn't a message it knows", async () => {
    expect((await rpc(reader, "resources/list")).error).toMatchObject({ code: -32601 });
    const batch = await request(ctx.app)
      .post("/api/v1/mcp")
      .set("Authorization", `Bearer ${reader}`)
      .send([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    expect(batch.body.error.code).toBe(-32600);
    const junk = await request(ctx.app)
      .post("/api/v1/mcp")
      .set("Authorization", `Bearer ${reader}`)
      .send({ hello: "world" });
    expect(junk.body.error.code).toBe(-32600);
  });

  it("lists the tools the key's scopes allow, each with its input", async () => {
    const names = async (key: string) =>
      ((await rpc(key, "tools/list")).result?.tools as Array<{ name: string }>).map((t) => t.name);
    expect((await names(reader)).sort()).toEqual(
      ["get_incident", "get_monitor", "list_incidents", "list_monitors", "whoami"].sort(),
    );
    expect((await names(writer)).sort()).toEqual(
      [
        "acknowledge_incident",
        "create_maintenance_window",
        "get_incident",
        "get_monitor",
        "list_incidents",
        "list_maintenance_windows",
        "list_monitors",
        "resolve_incident",
        "whoami",
      ].sort(),
    );

    const tools = (await rpc(writer, "tools/list")).result?.tools as Array<{
      name: string;
      description: string;
      inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] };
      annotations: Record<string, unknown>;
    }>;
    const tool = (name: string) => tools.find((t) => t.name === name);
    expect(tool("get_incident")?.inputSchema).toMatchObject({
      type: "object",
      required: ["incidentRef"],
    });
    expect(Object.keys(tool("list_monitors")?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["limit", "cursor", "q", "type", "paused"]),
    );
    expect(tool("create_maintenance_window")?.inputSchema.required).toEqual(
      expect.arrayContaining(["name", "startsAt", "endsAt", "scope"]),
    );
    expect(tool("list_incidents")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(tool("acknowledge_incident")?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: true,
    });
    expect(tool("create_maintenance_window")?.annotations.idempotentHint).toBe(false);
    for (const t of tools) expect(t.description.length).toBeGreaterThan(40);
    /* docs/mcp.md has a row for each. */
    const guide = readFileSync(new URL("../../../docs/mcp.md", import.meta.url), "utf8");
    for (const t of tools) expect(guide).toContain(`| \`${t.name}\``);
  });

  it("reads monitors and incidents", async () => {
    const me = await call(reader, "whoami");
    expect(me.data).toMatchObject({ workspaceId: ws, workspaceName: "MCP Co" });

    const list = await call(reader, "list_monitors", { limit: 10, paused: false });
    expect(list.data).toMatchObject({
      data: [{ id: monitorId, name: "Checkout API", type: "tcp" }],
      nextCursor: null,
    });
    expect((await call(reader, "get_monitor", { monitorId })).data).toMatchObject({
      name: "Checkout API",
    });

    const open = await call(reader, "list_incidents", { status: "open" });
    expect(open.data).toMatchObject({
      data: [{ number: incidentNumber, title: "Checkout is down", status: "triggered" }],
    });
    /* By number, as people say it, or by ID. */
    const byNumber = await call(reader, "get_incident", { incidentRef: incidentNumber });
    expect(byNumber.data).toMatchObject({ number: incidentNumber, severity: "critical" });
    const id = (byNumber.data as { id: string }).id;
    expect((await call(reader, "get_incident", { incidentRef: id })).data).toMatchObject({ id });
  });

  it("tells the model what went wrong instead of failing the call", async () => {
    const missing = await call(reader, "get_incident", { incidentRef: 999_999 });
    expect(missing).toMatchObject({ isError: true });
    expect(missing.text).toMatch(/not found/i);

    const invalid = await call(reader, "list_monitors", { limit: 5_000 });
    expect(invalid.isError).toBe(true);
    expect(invalid.text).toMatch(/^Invalid arguments\. limit: /);
    const extra = await call(reader, "list_monitors", { colour: "red" });
    expect(extra.text).toBe("Invalid arguments. colour: is not an argument of this tool");

    /* A tool the key may not use doesn't exist for it. */
    const hidden = await rpc(reader, "tools/call", {
      name: "acknowledge_incident",
      arguments: { incidentRef: incidentNumber },
    });
    expect(hidden.error).toMatchObject({ code: -32602 });
    expect((await session("get", `/incidents/${incidentNumber}`)).body.status).toBe("triggered");
  });

  it("acknowledges an incident and creates a maintenance window", async () => {
    const acked = await call(writer, "acknowledge_incident", { incidentRef: incidentNumber });
    expect(acked.data).toMatchObject({ number: incidentNumber, status: "acknowledged" });
    const detail = await session("get", `/incidents/${incidentNumber}`);
    expect(detail.body.status).toBe("acknowledged");
    const event = (detail.body.timeline as Array<{ type: string; data: { via?: string } }>).find(
      (e) => e.type === "acknowledged",
    );
    expect(event?.data.via).toBe("api");
    /* Twice changes nothing more. */
    expect(
      (await call(writer, "acknowledge_incident", { incidentRef: incidentNumber })).data,
    ).toMatchObject({ status: "acknowledged" });

    const start = clock.now().getTime() + 3_600_000;
    const made = await call(writer, "create_maintenance_window", {
      name: "Deploy",
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(start + 1_800_000).toISOString(),
      scope: { monitorIds: [monitorId] },
    });
    expect(made.data).toMatchObject({ name: "Deploy", active: false, suppressAlerts: true });
    const windows = await call(writer, "list_maintenance_windows");
    expect((windows.data as { data: Array<{ name: string }> }).data.map((w) => w.name)).toEqual([
      "Deploy",
    ]);

    const backwards = await call(writer, "create_maintenance_window", {
      name: "Wrong",
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(start - 60_000).toISOString(),
      scope: { all: true },
    });
    expect(backwards.isError).toBe(true);
    expect(backwards.text).toContain("endsAt");

    expect(
      (await call(writer, "resolve_incident", { incidentRef: incidentNumber })).data,
    ).toMatchObject({ status: "resolved" });
  });

  it("on the Free plan the write tools say that writing needs a paid plan", async () => {
    clock.advance(20 * DAY);
    try {
      expect((await call(writer, "list_monitors")).isError).toBe(false);
      const refused = await call(writer, "create_maintenance_window", {
        name: "On Free",
        startsAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
        endsAt: new Date(clock.now().getTime() + 7_200_000).toISOString(),
        scope: { all: true },
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("paid plans");
    } finally {
      clock.advance(-20 * DAY);
    }
  });
});
