/* Postgres connection pool. Drizzle is layered on top of this pool in later tasks. */
import pg from "pg";

export type DbPool = pg.Pool;

export function createDbPool(connectionString: string, options: { max?: number } = {}): DbPool {
  return new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
}

export async function pingDb(pool: DbPool): Promise<void> {
  await pool.query("select 1");
}
