/* Applies pending Drizzle migrations from backend/drizzle. Used by src/migrate.ts and test setup. */
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, createDbPool } from "./pool.js";

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../../drizzle", import.meta.url));

export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = createDbPool(databaseUrl, { max: 1 });
  try {
    await migrate(createDb(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}
