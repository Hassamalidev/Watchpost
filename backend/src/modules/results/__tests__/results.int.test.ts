/*
 * P1-T09 AC against real Postgres: partitions exist 3 days ahead, old partitions are dropped,
 * ingest is idempotent, failures become check_events, and recent-result queries use the index.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createFakeClock } from "../../../core/clock.js";
import { createDb, createDbPool, type Db, type DbPool } from "../../../infra/db/index.js";
import { newId } from "../../../infra/ids.js";
import { createResultsRepository, partitionName } from "../results.repository.js";
import { createResultsService, type StoredResult } from "../results.service.js";
import { checkEvents } from "../schema/check-events.js";
import { TEST_DATABASE_URL } from "../../../__tests__/helpers/test-env.js";

let pool: DbPool;
let db: Db;
const clock = createFakeClock(new Date());
let service: ReturnType<typeof createResultsService>;
const repo = () => createResultsRepository(db);
const DAY = 86_400_000;

const result = (overrides: Partial<StoredResult> = {}): StoredResult => ({
  id: newId(),
  workspaceId: "0190a3b2-7c1d-7e3f-8a9b-0c1d2e3f4a5b",
  monitorId: "0190a3b2-0000-7000-8000-00000000abcd",
  region: "eu-central",
  checkedAt: clock.now().toISOString(),
  ok: true,
  latencyMs: 42,
  ...overrides,
});

beforeAll(async () => {
  pool = createDbPool(TEST_DATABASE_URL, { max: 3 });
  db = createDb(pool);
  service = createResultsService({ db, repository: repo(), clock });
  await service.maintainPartitions();
});

afterAll(async () => {
  await pool.end();
});

describe("partitions", () => {
  it("exist from yesterday to 3 days ahead", async () => {
    const partitions = await repo().listPartitions();
    const today = new Date(
      Date.UTC(clock.now().getUTCFullYear(), clock.now().getUTCMonth(), clock.now().getUTCDate()),
    );
    for (let i = -1; i <= 3; i += 1) {
      expect(partitions).toContain(partitionName(new Date(today.getTime() + i * DAY)));
    }
  });

  it("drops partitions older than the 48 h raw retention and keeps recent ones", async () => {
    const old = new Date(Date.UTC(2020, 0, 1));
    await repo().createPartition(old);
    expect(await repo().listPartitions()).toContain("check_results_p20200101");
    const { dropped } = await service.maintainPartitions();
    expect(dropped).toContain("check_results_p20200101");
    expect(await repo().listPartitions()).not.toContain("check_results_p20200101");
    expect(dropped.some((name) => name === partitionName(new Date(clock.now().getTime())))).toBe(
      false,
    );
  });

  it("is idempotent", async () => {
    const again = await service.maintainPartitions();
    expect(again.created).toEqual([]);
  });

  it("refuses to drop anything that isn't a check_results partition", async () => {
    await expect(repo().dropPartition("monitors")).rejects.toThrow(/refusing/);
  });
});

describe("ingest", () => {
  it("stores a batch once, however many times it is sent", async () => {
    const batch = [
      result(),
      result({ ok: false, errorCode: "connect_refused", message: "refused" }),
    ];
    const first = await service.ingest(batch);
    expect(first).toMatchObject({ accepted: 2, duplicates: 0, rejected: 0 });
    const second = await service.ingest(batch);
    expect(second).toMatchObject({ accepted: 0, duplicates: 2, rejected: 0 });

    const rows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from check_results where id in (${sql.join(
        batch.map((b) => sql`${b.id}`),
        sql`, `,
      )})`,
    );
    expect(rows.rows[0]?.n).toBe(2);
  });

  it("records a check_event for each new failure", async () => {
    const failed = result({
      ok: false,
      errorCode: "http_status_unexpected",
      httpStatus: 502,
      message: "HTTP 502",
    });
    await service.ingest([failed]);
    await service.ingest([failed]);
    const events = await db.select().from(checkEvents).where(eq(checkEvents.id, failed.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "failure",
      errorCode: "http_status_unexpected",
      httpStatus: 502,
    });
  });

  it("rejects results outside the accepted time window", async () => {
    const outcome = await service.ingest([
      result({ checkedAt: new Date(clock.now().getTime() - 2 * DAY).toISOString() }),
      result({ checkedAt: new Date(clock.now().getTime() + 60 * 60_000).toISOString() }),
      result(),
    ]);
    expect(outcome).toMatchObject({ accepted: 1, rejected: 2 });
  });

  it("returns recent results newest first", async () => {
    const monitorId = newId();
    const base = clock.now().getTime();
    await service.ingest(
      [0, 1, 2].map((i) =>
        result({ monitorId, checkedAt: new Date(base - i * 60_000).toISOString(), latencyMs: i }),
      ),
    );
    const recent = await service.recent(monitorId, "eu-central", 2);
    expect(recent.map((r) => r.latencyMs)).toEqual([0, 1]);
  });
});

describe("index use", () => {
  it("answers the per-monitor recent-results query with the monitor/region/time index", async () => {
    const monitorId = newId();
    await db.execute(sql`
      insert into check_results (checked_at, id, workspace_id, monitor_id, region, ok, latency_ms)
      select now() - (g * interval '1 second'), gen_random_uuid(), ${result().workspaceId}::uuid,
             case when g % 50 = 0 then ${monitorId}::uuid else gen_random_uuid() end,
             'eu-central', true, g % 300
      from generate_series(1, 20000) g`);
    await db.execute(sql`analyze check_results`);
    const plan = await db.execute<{ "QUERY PLAN": string }>(sql`
      explain select * from check_results
      where monitor_id = ${monitorId}::uuid and region = 'eu-central'
      order by checked_at desc limit 5`);
    const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(text).toMatch(/Index Scan|Index Only Scan|Bitmap Index Scan/);
    expect(text).toContain("monitor_id_region_checked_at");
    expect(text).not.toMatch(/Seq Scan on check_results_p/);
  });
});
