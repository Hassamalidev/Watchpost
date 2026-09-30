/* Postgres connection pool and the Drizzle client built on it. */
import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";

export type DbPool = pg.Pool;
export type Db = NodePgDatabase;
/* A transaction handle; repositories accept `Db | Tx` so callers can pass `tx` across modules. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

export function createDbPool(connectionString: string, options: { max?: number } = {}): DbPool {
  return new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
}

export function createDb(pool: DbPool): Db {
  return drizzle({ client: pool });
}

export async function pingDb(pool: DbPool): Promise<void> {
  await pool.query("select 1");
}
