/* Vitest global setup: migrate the test database once before any test file runs. */
import { createDbPool } from "../../infra/db/pool.js";
import { runMigrations } from "../../infra/db/migrate.js";
import { TEST_DATABASE_URL } from "./test-env.js";

/*
 * check_results has one partition per day. The migration creates them around the day it runs and the
 * worker keeps them ahead after that, but no worker runs between test runs: a local database left
 * idle for a few days has no partition for today, and every test that stores a result fails. Same
 * range and statement as drizzle/0005_check_results.sql.
 */
async function ensureResultPartitions(databaseUrl: string): Promise<void> {
  const pool = createDbPool(databaseUrl, { max: 1 });
  try {
    await pool.query(`
      DO $$
      DECLARE
        day date;
      BEGIN
        FOR day IN SELECT generate_series(
          (now() AT TIME ZONE 'UTC')::date - 2, (now() AT TIME ZONE 'UTC')::date + 3, interval '1 day'
        )::date LOOP
          EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF check_results FOR VALUES FROM (%L) TO (%L)',
            'check_results_p' || to_char(day, 'YYYYMMDD'),
            day::timestamp AT TIME ZONE 'UTC',
            (day + 1)::timestamp AT TIME ZONE 'UTC'
          );
        END LOOP;
      END $$;`);
  } finally {
    await pool.end();
  }
}

export default async function setup(): Promise<void> {
  await runMigrations(TEST_DATABASE_URL);
  await ensureResultPartitions(TEST_DATABASE_URL);
}
