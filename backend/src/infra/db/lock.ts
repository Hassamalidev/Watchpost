/*
 * One change at a time for a key (a workspace's monitors, its client workspaces), so a limit
 * counted and then acted on can't be passed by requests that arrive together.
 *
 * The lock is a Postgres advisory lock held for one transaction. It is *tried*, not waited for
 * inside the database: a request that waits there keeps a pooled connection while it waits, and
 * enough of them leave none for the request that holds the lock, which then can't finish. Found by
 * creating 60 monitors at once: 51 failed with "timeout exceeded when trying to connect".
 */
import { sql } from "drizzle-orm";
import { ConflictError } from "../../core/errors.js";
import type { Db, Tx } from "./pool.js";

const DEFAULT_WAIT_MS = 15_000;

export async function withAdvisoryLock<T>(
  db: Db,
  key: string,
  fn: (tx: Tx) => Promise<T>,
  options: { waitMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (options.waitMs ?? DEFAULT_WAIT_MS);
  for (;;) {
    const done = await db.transaction(async (tx) => {
      const result = await tx.execute<{ ok: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${key}, 7)) as ok`,
      );
      if (result.rows[0]?.ok !== true) return undefined;
      return { value: await fn(tx) };
    });
    if (done !== undefined) return done.value;
    if (Date.now() >= deadline) {
      throw new ConflictError("Other changes are being saved right now. Try again in a moment.");
    }
    /* Uneven pauses, so waiting requests don't all come back at the same instant. */
    await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 40));
  }
}
