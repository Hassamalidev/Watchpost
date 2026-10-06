# Agent instructions

1. Read PRODUCT.md §2 and STACK.md before doing anything.
2. Work only on the task in PRODUCT.md's "Next task"; follow its acceptance criteria.
3. After each task: pnpm lint, typecheck, test → commit (Conventional Commits + task ID) → push.
4. Update PRODUCT.md in the same commit (tick task, next task, decisions, backlog, changelog).
5. Never commit secrets or force-push main. Ask the owner before spending money or changing scope.
6. Before writing code, read PRODUCT.md §7.1 (architecture rules) and follow the module template in §7.3.
7. To find code: module map (§7.4) → exact names with grep/ripgrep → grep the owning module for domain words (§2.8). No code index.

## Finding code (search order, PRODUCT.md §2.8)

1. Module map (§7.4) and file naming (§7.3) → open the file directly (`modules/<name>/<name>.<layer>.ts`).
2. Exact identifier, route, table or error code → grep/ripgrep.
3. Conceptual question ("how do we decide a monitor is down?") → find the owning module in the module map, then grep its files for the domain words.
4. Only then read whole folders.

There is no semantic code index: the owner dropped CocoIndex (D-056). Don't use or reinstall it.

## Useful commands

`docker compose up -d` · `pnpm dev` · `pnpm lint` · `pnpm arch` · `pnpm typecheck` · `pnpm test` · `pnpm test:e2e` · `pnpm new:module <name>` · `pnpm db:migrate` · `pnpm --filter @app/api db:generate`
