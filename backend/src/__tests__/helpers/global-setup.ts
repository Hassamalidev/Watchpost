/* Vitest global setup: migrate the test database once before any test file runs. */
import { runMigrations } from "../../infra/db/migrate.js";
import { TEST_DATABASE_URL } from "./test-env.js";

export default async function setup(): Promise<void> {
  await runMigrations(TEST_DATABASE_URL);
}
