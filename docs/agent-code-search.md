# Agent code search (CocoIndex Code)

Developer tooling only (PRODUCT.md §2.8): it is not part of the product and nothing here ships to production.

## One-time setup per machine

```sh
uv tool install "cocoindex-code[full]"     # or: pipx install "cocoindex-code[full]"
```

Use the `[full]` variant: it embeds code locally with `sentence-transformers`, so source code never leaves the machine. The slim variant sends code chunks to a cloud embedding provider; don't use it here.

The global settings (`~/.cocoindex_code/global_settings.yml`) pin the local model:

```yaml
embedding:
  provider: sentence-transformers
  model: Snowflake/snowflake-arctic-embed-xs
  device: cpu
```

## Per project

```sh
ccc init      # once: creates .cocoindex_code/settings.yml (gitignored)
ccc index     # build or refresh the index (incremental)
ccc search "where do we verify the probe signature?"
ccc status    # where the index lives, chunk and file counts
ccc reset     # delete the index if it gets into a bad state
```

The index database lives in `.cocoindex_code/` at the repo root, which is gitignored. Never commit it.

## Agents

`.mcp.json` at the repo root registers the `cocoindex-code` MCP server (`ccc mcp`) for every Claude Code session in this project; Claude Code asks once to approve project-scoped servers. The MCP search tool refreshes the index before each query by default. Other agents: `codex mcp add cocoindex-code -- ccc mcp`.

## Keep or drop

Measured with `docs/agent-benchmark.md` at the end of Phase 1 and at every phase retro (decision D-013).
