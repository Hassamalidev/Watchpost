/*
 * Config used only by the Better Auth CLI to generate src/infra/auth/schema.ts:
 *   pnpm --filter @app/api auth:generate
 * It never connects to a database; values are placeholders.
 */
import { createAuth } from "../src/infra/auth/auth.js";
import { createDb, createDbPool } from "../src/infra/db/index.js";

export const auth = createAuth({
  db: createDb(createDbPool("postgres://unused:unused@127.0.0.1:1/unused")),
  baseURL: "http://localhost:4000",
  secret: "x".repeat(32),
  webOrigin: "http://localhost:3000",
  requestEmail: async () => {},
  rateLimit: false,
  turnstile: { secretKey: "unused" },
});
