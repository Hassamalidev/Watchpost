/*
 * Wakes long-polling probes when a task is created (PRODUCT.md §7.6: GET /tasks returns as soon as
 * one arrives). One LISTEN connection per API process; NOTIFY payloads name the region (or
 * "workspace:<id>" for private probes). Postgres delivers NOTIFY only after the task commits.
 */
import type pg from "pg";

export const TASK_CHANNEL = "probe_tasks";

export interface TaskNotifier {
  /* Resolves true when a task for `key` is announced, false on timeout or close. */
  wait(key: string, timeoutMs: number): Promise<boolean>;
  close(): Promise<void>;
}

export function createTaskNotifier(pool: pg.Pool): TaskNotifier {
  const waiters = new Map<string, Set<(woken: boolean) => void>>();
  let client: pg.PoolClient | undefined;
  let connecting: Promise<void> | undefined;
  let closed = false;

  const wakeAll = (key: string | undefined) => {
    for (const [k, set] of waiters) {
      if (key !== undefined && k !== key) continue;
      for (const resolve of set) resolve(true);
      set.clear();
    }
  };

  async function ensureListening(): Promise<void> {
    if (client || closed) return;
    connecting ??= (async () => {
      const c = await pool.connect();
      c.on("notification", (msg) => {
        if (msg.channel === TASK_CHANNEL) wakeAll(msg.payload);
      });
      c.on("error", () => {
        /* Drop the broken client; the next wait reconnects. Waiters time out normally. */
        client = undefined;
        connecting = undefined;
        c.release(true);
      });
      await c.query(`LISTEN ${TASK_CHANNEL}`);
      client = c;
    })().finally(() => {
      connecting = undefined;
    });
    await connecting;
  }

  return {
    async wait(key, timeoutMs) {
      if (closed) return false;
      await ensureListening();
      return new Promise<boolean>((resolve) => {
        const set = waiters.get(key) ?? new Set();
        waiters.set(key, set);
        const done = (woken: boolean) => {
          clearTimeout(timer);
          set.delete(done);
          resolve(woken);
        };
        const timer = setTimeout(() => done(false), timeoutMs);
        set.add(done);
      });
    },
    async close() {
      closed = true;
      for (const set of waiters.values()) for (const resolve of set) resolve(false);
      waiters.clear();
      if (client) {
        await client.query(`UNLISTEN ${TASK_CHANNEL}`).catch(() => {});
        client.release();
        client = undefined;
      }
    },
  };
}
