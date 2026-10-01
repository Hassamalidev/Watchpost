/*
 * Gives the e2e run a clean database. Locally the default is `watchpost_e2e`, recreated on every run so
 * monitors left by earlier runs (or by integration tests in the dev database) don't load the e2e probe.
 * Only a database whose name ends in `_e2e` is ever dropped; any other (CI's) is just migrated.
 */
import pg from "pg";

const url = new URL(process.env.DATABASE_URL ?? "");
const name = url.pathname.slice(1);
if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unexpected database name "${name}"`);

if (name.endsWith("_e2e")) {
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    await client.query(`drop database if exists ${name} with (force)`);
    await client.query(`create database ${name}`);
  } finally {
    await client.end();
  }
}

const { runMigrations } = await import(
  new URL("../../dist/infra/db/migrate.js", import.meta.url).href
);
await runMigrations(url.toString());
process.stdout.write(`e2e database ${name} ready\n`);
