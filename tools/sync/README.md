# Monitoring sync

Keeps a workspace's monitors in step with a file in your repository ("monitoring as code"). It talks to the public API (`docs/api.md`) with an API key and runs as a command or as a GitHub Action.

## The file

YAML or JSON. Every monitor has a `key` that never changes: it is how an entry is matched to a monitor in the workspace, so you can rename a monitor without it being deleted and made again.

```yaml
version: 1
monitors:
  - key: shop
    name: Shop
    config:
      type: http
      url: https://shop.example.com
    settings:
      intervalSeconds: 60
      tags: [production]
  - key: shop-db
    name: Shop database port
    config: { type: tcp, host: db.example.com, port: 5432 }
    paused: true
```

`config` and `settings` are what the API's `POST /monitors` takes (see `/api/v1/openapi.json`). The name stands next to the key, not in `settings`.

## What a run does

- `plan` reads the file and the workspace and prints what would change. Nothing is changed. It needs `monitors:read`.
- `apply` creates the monitors that are missing, updates the ones whose entry changed, and pauses or resumes to match `paused`. It needs `monitors:write`, so a paid plan.
- With `--prune`, managed monitors whose key is no longer in the file are deleted. Without it they are left alone.

Managed monitors carry two tags: `sync:key=<key>` and `sync:rev=<hash of the entry>`. That is all the state there is; nothing is stored in the repository.

- Monitors without a `sync:key=` tag are never touched, with or without `--prune`.
- An entry is applied when its hash differs from the tag. A change made by hand in the app does not change the tag, so it stays until the entry changes in the file. `--force` applies every entry again.
- Removing a setting from the file does not reset it: the API merges `settings` with what is stored. Write the value you want.
- If one monitor is refused (a setting the plan doesn't allow, a mistake the API finds), the others are still applied and the run ends with exit code 1.

## Command

```sh
export MONITORING_API_KEY=wp_...
export MONITORING_URL=https://app.example.com
node tools/sync/action/index.mjs plan --file monitoring.yml
node tools/sync/action/index.mjs apply --file monitoring.yml --prune
```

`plan --detailed-exitcode` exits with 2 when there is something to change, for scripts that want to know.

## GitHub Action

```yaml
name: Monitoring
on:
  pull_request:
    paths: [monitoring.yml]
  push:
    branches: [main]
    paths: [monitoring.yml]
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Hassamalidev/Watchpost/tools/sync@main
        with:
          file: monitoring.yml
          mode: ${{ github.event_name == 'push' && 'apply' || 'plan' }}
          prune: "true"
          api-key: ${{ secrets.MONITORING_API_KEY }}
          url: https://app.example.com
```

Pull requests show the plan; a push to `main` applies it.

## Development

`src/` is TypeScript; `action/index.mjs` is the bundle the action and the command run, built with `pnpm --filter @app/sync build` and committed. A test fails when it is out of date.
