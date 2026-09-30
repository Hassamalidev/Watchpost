/*
 * email.requested end to end: requestEmail (outbox, own transaction) → relay → emails queue →
 * processor renders the template and sends once, even if the job is delivered twice.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pino } from "pino";
import type { Redis } from "ioredis";
import { createDb, createDbPool, type Db, type DbPool } from "../../db/index.js";
import { createOutbox, createOutboxRelay, eventJobId, outboxEvents } from "../../outbox/index.js";
import {
  createQueueConnection,
  createQueues,
  createWorkerRuntime,
  type Queues,
} from "../../queues/index.js";
import {
  createEmailProcessor,
  createEmailRequester,
  createMemoryTransport,
  renderEmail,
} from "../index.js";
import { TEST_DATABASE_URL, TEST_REDIS_URL } from "../../../__tests__/helpers/test-env.js";

const logger = pino({ level: "silent" });
const prefix = `test-email-${randomUUID()}`;
let pool: DbPool;
let db: Db;
let connection: Redis;
let queues: Queues;

beforeAll(() => {
  pool = createDbPool(TEST_DATABASE_URL, { max: 3 });
  db = createDb(pool);
  connection = createQueueConnection(TEST_REDIS_URL);
  queues = createQueues(connection, { prefix });
});

afterAll(async () => {
  await queues.get("emails").obliterate({ force: true });
  await queues.close();
  await connection.quit();
  await pool.end();
});

describe("templates", () => {
  it("renders every auth template and rejects bad data", () => {
    expect(
      renderEmail("verify-email", { url: "https://app.example.com/v?t=1", name: "Sara" }).text,
    ).toContain("Hi Sara");
    expect(renderEmail("magic-link", { url: "https://x.example/m" }).subject).toMatch(
      /sign-in link/,
    );
    expect(
      renderEmail("invite", {
        url: "https://app.example.com/invite/1",
        workspaceName: "Acme",
        inviterName: "Sara",
        role: "member",
      }).subject,
    ).toBe("Sara invited you to Acme on Watchpost");
    expect(() => renderEmail("verify-email", { url: "not a url" })).toThrow();
    expect(() => renderEmail("nope", {})).toThrow(/Unknown email template/);
  });
});

describe("email pipeline", () => {
  it("sends a requested email exactly once through the outbox and the emails queue", async () => {
    const transport = createMemoryTransport();
    const requestEmail = createEmailRequester({ db, outbox: createOutbox() });
    const to = `pipeline-${randomUUID()}@example.com`;

    await requestEmail("magic-link", to, { url: "https://app.example.com/magic?token=abc" });
    const [row] = await db
      .select()
      .from(outboxEvents)
      .where((await import("drizzle-orm")).sql`${outboxEvents.payload}->>'to' = ${to}`);
    expect(row?.type).toBe("email.requested");

    const relay = createOutboxRelay({
      db,
      pool,
      queues,
      logger,
      subscribersOf: (type) =>
        type === "email.requested" ? [{ handler: "email", queue: "emails" }] : [],
    });
    await relay.drain();

    const runtime = createWorkerRuntime({
      connection,
      logger,
      prefix,
      processors: [
        createEmailProcessor({ db, transport, from: "Watchpost <test@example.com>", logger }),
      ],
    });
    await runtime.start();
    try {
      /* A duplicate delivery of the same event (for example after a crash) must not send twice. */
      await queues.enqueue(
        "emails",
        "email.requested",
        { eventId: row?.id, type: "email.requested", handler: "email" },
        { jobId: `${eventJobId(row?.id ?? "", "email")}.dup` },
      );
      const started = Date.now();
      while (
        transport.sent.filter((m) => m.to === to).length === 0 &&
        Date.now() - started < 5_000
      ) {
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => setTimeout(r, 300));
      const sent = transport.sent.filter((m) => m.to === to);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        from: "Watchpost <test@example.com>",
        subject: "Your Watchpost sign-in link",
        idempotencyKey: row?.id,
      });
      expect(sent[0]?.text).toContain("https://app.example.com/magic?token=abc");
    } finally {
      await runtime.stop();
    }
  });
});
