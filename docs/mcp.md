# MCP server

AI assistants that speak the Model Context Protocol (Claude, Cursor and others) can read a workspace's monitors and incidents, acknowledge and resolve incidents, and create maintenance windows. The server is part of the API: one address, the same API keys, the same scopes and limits as the public API (`docs/api.md`).

- **Address:** `https://YOUR-HOST/api/v1/mcp`
- **Transport:** Streamable HTTP. Every request is a `POST` of one JSON-RPC message and gets one JSON answer; there is no event stream and no session.
- **Authentication:** `Authorization: Bearer <API key>`. Make a key under **Settings → API keys** with only the scopes the assistant should have.

## Connect

Claude Code:

```sh
claude mcp add --transport http monitoring https://YOUR-HOST/api/v1/mcp \
  --header "Authorization: Bearer $API_KEY"
```

Clients configured with JSON (Cursor, Claude Desktop with a remote server, and others):

```json
{
  "mcpServers": {
    "monitoring": {
      "url": "https://YOUR-HOST/api/v1/mcp",
      "headers": { "Authorization": "Bearer wp_..." }
    }
  }
}
```

## Tools

| Tool                        | Scope               | What it does                                          |
| --------------------------- | ------------------- | ----------------------------------------------------- |
| `whoami`                    | any                 | The workspace and what the key may do                 |
| `list_monitors`             | `monitors:read`     | List monitors; filter by text, type, tag or paused    |
| `get_monitor`               | `monitors:read`     | One monitor with what it checks                       |
| `list_incidents`            | `incidents:read`    | List incidents; `status: "open"` is what is wrong now |
| `get_incident`              | `incidents:read`    | One incident by number or ID                          |
| `acknowledge_incident`      | `incidents:write`   | Acknowledge; escalation stops                         |
| `resolve_incident`          | `incidents:write`   | Resolve                                               |
| `list_maintenance_windows`  | `maintenance:read`  | List maintenance windows                              |
| `create_maintenance_window` | `maintenance:write` | Silence alerts for some or all monitors for a period  |

A key sees only the tools its scopes allow; a write scope includes reading. The tools that change something need a plan with API write access, as in the API. Creating, changing and deleting monitors, and deleting maintenance windows, are deliberately not tools: use the API or the sync tool for those.

## What to expect

- A tool's input is what its API route takes (path, query and body fields side by side), and its answer is the route's JSON answer as text.
- When a call can't be done (bad arguments, nothing found, a scope or the plan doesn't allow it), the answer is a normal tool result marked `isError` with the reason in words, so the assistant can read it and try something else.
- What a tool changes is recorded as coming from the API, without a person's name, like any API call.
- Each key may make 120 requests a minute, shared with its API calls.
- The server sends short instructions when the assistant connects: acknowledge or resolve only when the person asks, and create a maintenance window only for a period the person names. Give assistants a key with read scopes unless they are meant to act.

## For developers of this codebase

- A tool is a public route that names itself one: add `tool: { name, description }` to its `publicRoute({ … })`. The input schema, the scope check and the answer come from the route. `backend/src/core/mcp.ts` is the protocol (JSON-RPC, `initialize`, `tools/list`, `tools/call`, `ping`); `backend/src/composition/public-api.ts` mounts it at `/api/v1/mcp` behind the key check and the rate limit.
- Write the description for a model choosing between tools: what it does, when to use it, and when not to.
- Add a row to the table above; a test fails when a tool is missing from this page.
