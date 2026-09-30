# Watchpost — Stack and Conventions (`STACK.md`)

> **Status: DRAFT — needs owner review.** The original STACK.md was not in the repo at P0-T01, so the build agent reconstructed this file from every stack statement in PRODUCT.md (2026-09-30). If you have the original, replace this file and note it in PRODUCT.md §23.
> PRODUCT.md is the "what"; this file is the "how". Changing anything here needs an owner-approved proposal (PRODUCT.md §2.4, §21.1).

## 1. Summary

TypeScript everywhere · pnpm workspaces + Turborepo · Express 5 API and a BullMQ worker from one codebase · Next.js 16 web app · Postgres 17 (Drizzle ORM) · Redis 7 (BullMQ, locks, rate limits only) · Better Auth · Paddle · Cloudflare R2 · Resend · Claude Haiku 4.5 · Docker Compose behind Caddy.

## 2. Versions (pinned; bump deliberately)

| Area            | Tool                                                                                                         | Version                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Runtime         | Node.js                                                                                                      | 24 LTS (`.nvmrc`)                                      |
| Package manager | pnpm (via Corepack)                                                                                          | 12.8.x (`packageManager` field)                        |
| Monorepo        | Turborepo                                                                                                    | 2.11.x                                                 |
| Language        | TypeScript                                                                                                   | 6.0.x (7.x blocked: typescript-eslint supports `<6.1`) |
| Lint / format   | ESLint 10 (flat config) + typescript-eslint 8, Prettier 3                                                    |                                                        |
| Tests           | Vitest 5, Supertest, Playwright                                                                              |                                                        |
| API             | Express 5, helmet 8, express-rate-limit 8 + rate-limit-redis, pino 10 + pino-http 11                         |                                                        |
| Validation      | Zod 4                                                                                                        |                                                        |
| DB              | Postgres 17, `pg` 8, Drizzle ORM 0.45 + drizzle-kit 0.31                                                     |                                                        |
| Queues          | Redis 7, BullMQ 6, ioredis                                                                                   |                                                        |
| Auth            | Better Auth 1.7 (Drizzle adapter, organization, twoFactor, magicLink plugins)                                |                                                        |
| Web             | Next.js 16 (App Router), React 19, Tailwind CSS v4, shadcn/ui, Geist font, TanStack Query 5, next-intl 4     |                                                        |
| Time            | Luxon 3, cron-parser 5                                                                                       |                                                        |
| Checks          | ipaddr.js, jsonata, @szmarczak/http-timer                                                                    |                                                        |
| Providers       | @paddle/paddle-node-sdk, Paddle.js, resend + React Email, @aws-sdk/client-s3 (R2), @anthropic-ai/sdk, twilio |                                                        |
| Architecture    | dependency-cruiser 18                                                                                        |                                                        |
| Dev runner      | tsx                                                                                                          |                                                        |

AI model: **Claude Haiku 4.5** (`claude-haiku-4-5-20251001`) for explainers, drafts and digests.

## 3. Packages

| Package            | Path                | Purpose                                                               |
| ------------------ | ------------------- | --------------------------------------------------------------------- |
| `@app/shared`      | `packages/shared`   | Zod schemas, types, constants, pure functions. Depends only on `zod`. |
| `@app/api`         | `backend`           | Express API (`src/server.ts`) and worker (`src/worker.ts`).           |
| `@app/web`         | `backend/web`       | Next.js marketing site, app and status pages.                         |
| `@app/probe`       | `probe`             | Regional and private probes.                                          |
| `@app/fake-target` | `tools/fake-target` | Dev-only outage simulator.                                            |

## 4. Repository layout

See PRODUCT.md §7.3 for the full tree and module template.

```
/
├─ package.json  pnpm-workspace.yaml  turbo.json  tsconfig.base.json
├─ docker-compose.yml  .env.example  .nvmrc
├─ packages/shared/
├─ backend/        (@app/api; backend/web is @app/web)
├─ probe/
├─ tools/fake-target/
└─ docs/
```

## 5. Code conventions (strict)

1. **Layers:** routes → controller → service → repository. Controllers: HTTP only. Repositories: Drizzle only, no business logic.
2. **Zod on every edge:** body, query, params, env, webhook payloads (after signature check), job data, event payloads, probe payloads.
3. **Comments:** block comments `/* */` only. Never `//` (a local ESLint rule enforces this).
4. **Postgres is the source of truth.** Redis holds only jobs, locks and rate limits.
5. **Jobs:** deterministic `jobId`s, exponential backoff, `removeOnFail: false`, recovery sweep on start, graceful shutdown (`worker.close()` on SIGTERM). Job data holds IDs only.
6. **Webhooks** mount before `express.json()` using `express.raw()`; verify the signature before parsing.
7. **Secrets:** third-party tokens encrypted with AES-256-GCM (`TOKEN_ENC_KEY` + key ID).
8. **Metering:** every paid external call writes a `usage_ledger` row.
9. **Tenancy:** every tenant query goes through the `WorkspaceScope` repository helper.
10. **Config:** env parsed once with Zod into `config`; no `process.env` outside `config/`.
11. **Time:** inject `clock.now()`; never `new Date()` in services. Store `timestamptz` UTC.
12. **IDs:** UUIDv7. **Money:** integer micros. **Errors:** `AppError` subclasses → RFC 9457 problem JSON.
13. **Naming:** files `<module>.<layer>.ts`; tables snake_case plural; events `domain.past_tense`; queues kebab-case.
14. **ESM** everywhere (`"type": "module"`), strict TypeScript, no `any` without a comment explaining why.
15. **Tests** live in `__tests__/` beside the code; write them with the code.

## 6. Local infrastructure (`docker-compose.yml`)

| Service     | Image                                                               | Port                                                                         |
| ----------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| postgres    | `postgres:17-alpine`                                                | host 5433 → 5432 (`POSTGRES_HOST_PORT`; avoids a locally installed Postgres) |
| redis       | `redis:7-alpine` (AOF on, `maxmemory-policy noeviction` for BullMQ) | 6379 (`REDIS_HOST_PORT`)                                                     |
| fake-target | built from `tools/fake-target`                                      | 4100 (HTTP), 4101 (TLS), 4102 (TCP echo)                                     |

Both data services have healthchecks. `pnpm dev` runs api (4000), worker and web (3000) on the host.

## 7. Environment variables

Base variables are in `.env.example`; product additions are in PRODUCT.md Appendix A. Only `.env.example` is committed. Key names: `NODE_ENV, LOG_LEVEL, API_PORT, TRUST_PROXY, WEB_ORIGIN, DATABASE_URL, REDIS_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL, TOKEN_ENC_KEY, TOKEN_ENC_KEY_ID, REVALIDATE_SECRET, RESEND_API_KEY, EMAIL_FROM, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, PADDLE_ENV, PADDLE_API_KEY, PADDLE_WEBHOOK_SECRET, NEXT_PUBLIC_PADDLE_CLIENT_TOKEN, ANTHROPIC_API_KEY, SENTRY_DSN`. Where to get Paddle and R2 keys: ENV_SETUP.md.

## 8. Frontend

- Next.js App Router in `backend/web`; the web app is a client of the API and never touches the database.
- Tailwind v4 with CSS-variable theme tokens; shadcn/ui primitives restyled per `DESIGN.md`; Geist Sans/Mono.
- Monochrome plus one brand color (Open decision #2). Reserved status colors: up green, degraded amber, down red, maintenance blue, paused gray. Light and dark themes.
- TanStack Query for server state; URL search params for filters; no global store. Forms: react-hook-form + Zod resolver with the API's schemas.
- `next-intl`, English first, RTL-ready.

## 9. Deployment

- One core server with Docker Compose: `caddy`, `web`, `api`, `worker`, `postgres`, `redis`, one-off `migrate`.
- Deploy: `docker compose pull` → `docker compose run --rm migrate` → `docker compose up -d`.
- Firewall: only 22 (restricted), 80 and 443 open; Postgres and Redis on the private Docker network only.
- Backups: nightly `pg_dump` to R2 (30-day retention) and one before every migration; monthly restore test.
- Images built in GitHub Actions and pushed to GHCR; the probe image is `ghcr.io/<org>/watchpost-probe`.
