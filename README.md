# Watchpost

Uptime monitoring, on-call and status pages that only page you for confirmed outages.

- Product spec and build plan: [PRODUCT.md](PRODUCT.md)
- Stack and conventions: [STACK.md](STACK.md)
- Keys and accounts: [ENV_SETUP.md](ENV_SETUP.md)

## Quick start

```sh
corepack enable
pnpm install
cp .env.example .env
docker compose up -d
pnpm dev
```
