/*
 * Outbox against real Postgres and Redis (PRODUCT.md P0-T09 AC):
 * rolled-back events are never dispatched; a duplicated dispatch is harmless; NOTIFY wakes the relay.
 * This file owns outbox_events during its run (tests in it are sequential).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { pino } from "pino";
import type { Redis } from "ioredis";
import { createDb, createDbPool, type Db, type DbPool } from "../../db/index.js";
import {
  createQueueConnection,
  createQueues,
  createWorkerRuntime,
  type Queues,
} from "../../queues/index.js";
import { newId } from "../../ids.js";
import {
  InvalidEventError,
  createOutbox,
  createOutboxRelay,
  defineEventProcessor,
  eventJobId,
  outboxEvents,
  type RelaySubscriber,
} from "../index.js";
import { TEST_DATABASE_URL, TEST_REDIS_URL } from "../../../__tests__/helpers/test-env.js";

const logger = pino({ level: "silent" });
const prefix = `test-outbox-${randomUUID()}`;
let pool: DbPool;
let db: Db;
let connection: Redis;
let queues: Queues;
const outbox = createOutbox();

const SUBSCRIBERS: Record<string, readonly RelaySubscriber[]> = {
  "incident.triggered": [
    { handler: "alerting", queue: "alerting-events" },
    { handler: "ai", queue: "ai-events" },
  ],
  "import.completed": [],
};
const subscribersOf = (type: string) => SUBSCRIBERS[type] ?? [];

const incident = () => ({
  incidentId: newId(),
  number: 1,
  severity: "critical" as const,
  title: "API down",
});

async function countRows(where = sql`true`): Promise<number> {
  const r = await db.execute<{ n: string }>(
    sql`select count(*)::text as n from ${outboxEvents} where ${where}`,
  );
  return Number(r.rows[0]?.n ?? 0);
}

beforeAll(() => {
  pool = createDbPool(TEST_DATABASE_URL, { max: 4 });
  db = createDb(pool);
  connection = createQueueConnection(TEST_REDIS_URL);
  queues = createQueues(connection, { prefix });
});

beforeEach(async () => {
  await db.delete(outboxEvents);
});

afterAll(async () => {
  for (const q of ["alerting-events", "ai-events"] as const)
    await queues.get(q).obliterate({ force: true });
  await queues.close();
  await connection.quit();
  await db.delete(outboxEvents);
  await pool.end();
});

describe("outbox.emit", () => {
  it("stores a validated, versioned event in the caller's transaction", async () => {
    const payload = incident();
    const id = await db.transaction((tx) =>
      outbox.emit(tx, "incident.triggered", payload, {
        workspaceId: newId(),
        correlationId: "req-1",
      }),
    );
    const rows = await db.select().from(outboxEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      type: "incident.triggered",
      version: 1,
      payload,
      correlationId: "req-1",
    });
    expect(rows[0]?.dispatchedAt).toBeNull();
  });

  it("rejects invalid payloads without inserting anything", async () => {
    await expect(
      db.transaction((tx) =>
        outbox.emit(tx, "incident.triggered", { incidentId: "nope" } as never),
      ),
    ).rejects.toThrow(InvalidEventError);
    expect(await countRows()).toBe(0);
  });

  it("an event emitted in a rolled-back transaction is never dispatched", async () => {
    await expect(
      db.transaction(async (tx) => {
        await outbox.emit(tx, "incident.triggered", incident());
        throw new Error("business rule failed");
      }),
    ).rejects.toThrow("business rule failed");

    const relay = createOutboxRelay({ db, pool, queues, logger, subscribersOf });
    expect(await relay.drain()).toBe(0);
    expect(await countRows()).toBe(0);
    expect(await queues.get("alerting-events").count()).toBe(0);
  });
});

describe("outbox relay", () => {
  it("enqueues one job per subscriber with deterministic IDs and marks rows dispatched", async () => {
    const id = await db.transaction((tx) => outbox.emit(tx, "incident.triggered", incident()));
    const relay = createOutboxRelay({ db, pool, queues, logger, subscribersOf });
    expect(await relay.drain()).toBe(1);

    const alertJob = await queues.get("alerting-events").getJob(eventJobId(id, "alerting"));
    const aiJob = await queues.get("ai-events").getJob(eventJobId(id, "ai"));
    expect(alertJob?.data).toEqual({
      eventId: id,
      type: "incident.triggered",
      handler: "alerting",
    });
    expect(aiJob).toBeDefined();
    expect(await countRows(sql`dispatched_at is null`)).toBe(0);
  });

  it("marks events without subscribers dispatched without enqueueing", async () => {
    await db.transaction((tx) =>
      outbox.emit(tx, "import.completed", { importId: newId(), source: "uptimerobot" }),
    );
    const relay = createOutboxRelay({ db, pool, queues, logger, subscribersOf });
    expect(await relay.drain()).toBe(1);
    expect(await countRows(sql`dispatched_at is null`)).toBe(0);
  });

  it("a duplicated dispatch (crash between enqueue and commit) is harmless", async () => {
    const id = await db.transaction((tx) => outbox.emit(tx, "incident.triggered", incident()));
    const alerting = queues.get("alerting-events");
    const before = await alerting.getJobCountByTypes(
      "waiting",
      "delayed",
      "active",
      "completed",
      "failed",
    );

    const crashing = createOutboxRelay({
      db,
      pool,
      queues,
      logger,
      subscribersOf,
      beforeCommit: async () => {
        throw new Error("process died before commit");
      },
    });
    await expect(crashing.drain()).rejects.toThrow("process died before commit");
    const [afterCrash] = await db.select().from(outboxEvents);
    expect(afterCrash?.dispatchedAt).toBeNull();
    expect(afterCrash?.attempts).toBe(1);
    expect(afterCrash?.lastError).toContain("process died");

    const healthy = createOutboxRelay({ db, pool, queues, logger, subscribersOf });
    expect(await healthy.drain()).toBe(1);

    const after = await alerting.getJobCountByTypes(
      "waiting",
      "delayed",
      "active",
      "completed",
      "failed",
    );
    expect(after - before).toBe(1);
    expect(await alerting.getJob(eventJobId(id, "alerting"))).toBeDefined();
    expect(await countRows(sql`dispatched_at is null`)).toBe(0);
  });

  it("wakes on NOTIFY after commit, without waiting for the poll", async () => {
    const relay = createOutboxRelay({
      db,
      pool,
      queues,
      logger,
      subscribersOf,
      pollIntervalMs: 60_000,
    });
    await relay.start();
    try {
      const id = await db.transaction((tx) => outbox.emit(tx, "incident.triggered", incident()));
      const started = Date.now();
      let job;
      while (job === undefined && Date.now() - started < 3_000) {
        job = await queues.get("alerting-events").getJob(eventJobId(id, "alerting"));
        if (job === undefined) await new Promise((r) => setTimeout(r, 25));
      }
      expect(job).toBeDefined();
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      await relay.stop();
    }
  });

  it("drains more rows than one batch", async () => {
    await db.transaction(async (tx) => {
      for (let i = 0; i < 7; i += 1) {
        await outbox.emit(tx, "import.completed", { importId: newId(), source: "kuma" });
      }
    });
    const relay = createOutboxRelay({ db, pool, queues, logger, subscribersOf, batchSize: 3 });
    expect(await relay.drain()).toBe(7);
  });
});

describe("lag and cleanup", () => {
  it("reports the age of the oldest undispatched event", async () => {
    expect(await outbox.lagSeconds(db)).toBe(0);
    await db.insert(outboxEvents).values({
      id: newId(),
      type: "import.completed",
      version: 1,
      payload: {},
      createdAt: sql`now() - interval '90 seconds'` as unknown as Date,
    });
    const lag = await outbox.lagSeconds(db);
    expect(lag).toBeGreaterThanOrEqual(89);
    expect(lag).toBeLessThan(120);
  });

  it("deletes only dispatched rows older than the retention", async () => {
    const old = newId();
    const recent = newId();
    const pending = newId();
    await db.insert(outboxEvents).values([
      {
        id: old,
        type: "x",
        version: 1,
        payload: {},
        dispatchedAt: sql`now() - interval '8 days'` as unknown as Date,
      },
      {
        id: recent,
        type: "x",
        version: 1,
        payload: {},
        dispatchedAt: sql`now() - interval '1 day'` as unknown as Date,
      },
      {
        id: pending,
        type: "x",
        version: 1,
        payload: {},
        createdAt: sql`now() - interval '9 days'` as unknown as Date,
      },
    ]);
    expect(await outbox.cleanup(db)).toBe(1);
    const ids = (await db.select({ id: outboxEvents.id }).from(outboxEvents))
      .map((r) => r.id)
      .sort();
    expect(ids).toEqual([recent, pending].sort());
  });
});

describe("event consumer", () => {
  it("reloads the event, validates it and calls the module handler (idempotently)", async () => {
    const received: string[] = [];
    const processor = defineEventProcessor({
      queue: "alerting-events",
      handler: "alerting",
      db,
      handlers: {
        "incident.triggered": async (payload, meta) => {
          received.push(`${payload.title}:${meta.eventId}`);
        },
      },
    });
    const runtime = createWorkerRuntime({ connection, logger, processors: [processor], prefix });
    await runtime.start();
    try {
      const id = await db.transaction((tx) => outbox.emit(tx, "incident.triggered", incident()));
      const relay = createOutboxRelay({ db, pool, queues, logger, subscribersOf });
      await relay.drain();
      /* A second enqueue of the same job ID (for example from a recovery sweep) is ignored. */
      await queues.enqueue(
        "alerting-events",
        "incident.triggered",
        { eventId: id, type: "incident.triggered", handler: "alerting" },
        { jobId: eventJobId(id, "alerting") },
      );
      const started = Date.now();
      while (received.length === 0 && Date.now() - started < 5_000) {
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => setTimeout(r, 200));
      expect(received).toEqual([`API down:${id}`]);
    } finally {
      await runtime.stop();
    }
  });
});
