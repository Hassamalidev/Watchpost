/* One-off migration entry point (`docker compose run --rm migrate`, or `pnpm db:migrate` locally). */
import { ConfigError, loadConfig } from "./config/index.js";
import { runMigrations } from "./infra/db/migrate.js";

try {
  const config = loadConfig();
  await runMigrations(config.databaseUrl);
  process.stdout.write("migrations applied\n");
} catch (err) {
  const message =
    err instanceof ConfigError ? err.message : err instanceof Error ? err.stack : String(err);
  process.stderr.write(`\nMigration failed:\n${message}\n\n`);
  process.exit(1);
}
