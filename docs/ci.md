# CI

Workflow: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml). It runs on every push and pull request.

| Job                              | What it runs                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Lint, typecheck, test, build** | `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (with Postgres 17 and Redis 7 service containers), `pnpm build` |
| **Web e2e and accessibility**    | Builds the web app, runs Playwright in light and dark with axe, then Lighthouse (accessibility must be at least 95)             |

Dependabot ([`.github/dependabot.yml`](../.github/dependabot.yml)) opens weekly PRs for npm packages (minor and patch grouped), GitHub Actions and the fake-target Docker image.

## Owner action: make failing checks block merges

CI marks a failing test red, but GitHub only **blocks** a merge when a branch rule requires the checks. Set this up once (repository admin):

1. GitHub → the repository → **Settings → Rules → Rulesets → New branch ruleset**.
2. Name: `main`. Enforcement: **Active**. Target branches: **Include default branch**.
3. Enable **Require a pull request before merging**.
4. Enable **Require status checks to pass**, then add both checks:
   - `Lint, typecheck, test, build`
   - `Web e2e and accessibility`
5. Enable **Block force pushes**. Save.

The checks only appear in the picker after they have run at least once (they have, on `phase/0-foundations`).

## Environment variables in CI

Turborepo runs tasks in strict env mode: a variable reaches a task only if `turbo.json` lists it (`env` per task or `globalPassThroughEnv`). When a test needs a new variable, add it there too, or the test silently gets its local default (D-024).

## Running the same checks locally

```sh
docker compose up -d
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm test:e2e                                  # Playwright, light and dark
pnpm --filter @app/web start & pnpm --filter @app/web lighthouse
```
