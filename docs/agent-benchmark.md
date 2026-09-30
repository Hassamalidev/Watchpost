# Agent code-search benchmark (PRODUCT.md §2.8, D-013)

Purpose: decide whether the CocoIndex Code index earns its place. Run every question and task twice, once **with** the `cocoindex-code` MCP server enabled and once **without** it (grep/ripgrep and the module map only), in fresh sessions. Keep the index only if tokens or time drop by at least 20% with no loss of correctness.

## How to run

1. Start a fresh agent session on a clean checkout of the commit being measured.
2. For "without": disable the server (`/mcp` → `cocoindex-code` → disable) or start with an empty MCP config.
3. Paste one question per session. Record input+output tokens, tool calls, wall time, and whether the answer names the right file **and** symbol.
4. Fill in the results table; summarize in D-013 (PRODUCT.md §20) and the phase retro.

## Questions ("find the code for X")

Answers are the expected file and symbol. Questions marked P1 get their answers when that code exists (end of Phase 1).

| #   | Question                                                                  | Expected answer                                                                                                                                                   |
| --- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Where are deterministic job IDs built, and why don't they contain `:`?    | `backend/src/infra/queues/job-options.ts` → `buildJobId`, `JOB_ID_SEPARATOR` (D-021)                                                                              |
| 2   | Where is an event payload validated before it is stored?                  | `backend/src/infra/outbox/outbox.ts` → `createOutbox().emit`, using `EVENT_SCHEMAS` in `packages/shared/src/schemas/events.ts`                                    |
| 3   | How does the outbox relay stop two workers from dispatching the same row? | `backend/src/infra/outbox/outbox.repository.ts` → `claimBatch` (`FOR UPDATE SKIP LOCKED`), called from `relay.ts` `dispatchBatch`                                 |
| 4   | Where is every tenant query forced to filter by workspace?                | `backend/src/infra/db/tenancy.ts` → `tenantWhere`, `withWorkspace`, `createTenantRepository`; scope type in `backend/src/core/workspace-scope.ts`                 |
| 5   | How are third-party tokens encrypted, and how is the key rotated?         | `backend/src/infra/crypto.ts` → `createTokenCipher` (`encrypt`, `rotate`, `needsRotation`); `docs/runbooks/secret-rotation.md`                                    |
| 6   | Where is the list of modules each module may call, and what enforces it?  | `backend/src/composition/module-edges.json` (typed in `architecture.ts`), enforced by `moduleEdgeRules` in `.dependency-cruiser.cjs` via `scripts/arch-check.mjs` |
| 7   | What makes `/api/ready` return 503?                                       | `backend/src/composition/container.ts` → `readinessChecks` (postgres, redis, outbox lag > 60 s); `backend/src/infra/health.ts` → `runReadinessChecks`             |
| 8   | Where are bad environment variables reported at boot?                     | `backend/src/config/env.ts` → `parseEnv`, `ConfigError`; printed by `bootConfig` in `backend/src/server.ts` and `worker.ts`                                       |
| 9   | (P1) How do we decide a monitor is down across regions?                   | `backend/src/modules/detection/…` → evaluation engine (§9.2), filled in at P1 exit                                                                                |
| 10  | (P1) Where is a probe request's HMAC signature verified?                  | `backend/src/middleware/probe-auth.ts` or the probes module (§7.6), filled in at P1 exit                                                                          |

## Real tasks

Each is small, has a clear definition of done, and touches several files. Reset the branch between runs.

| #   | Task                                                                                                        | Done when                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| T1  | Add a new event `monitor.paused` (payload `{ monitorId }`) consumed by `admin`.                             | Schema in `EVENT_SCHEMAS`, subscription in `EVENT_SUBSCRIPTIONS`, architecture and shared tests pass |
| T2  | Add a readiness check that fails when the worker's platform tick is older than 60 s (stub the tick source). | New check in the container, unit test for fresh and stale ticks                                      |
| T3  | Make `buildJobId` reject parts longer than 200 characters.                                                  | Change in one file plus a test; nothing else changes                                                 |

## Results

| Date | Commit | Run        | Item | Tokens (in/out) | Tool calls | Time | Correct? |
| ---- | ------ | ---------- | ---- | --------------- | ---------- | ---- | -------- |
|      |        | with index | Q1   |                 |            |      |          |
|      |        | without    | Q1   |                 |            |      |          |

Summary (fill in at the P1 exit): median token change, median time change, correctness changes, decision (keep/drop) and reason.
