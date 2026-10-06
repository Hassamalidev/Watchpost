/* Weekly digest v0: once per workspace and week, from Monday 08:00 UTC, to owners and admins. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { createFakeClock } from "../../../core/clock.js";
import { newId } from "../../../infra/ids.js";
import type { DetectionModule } from "../../detection/index.js";
import type { IncidentsModule } from "../../incidents/index.js";
import type { MonitorsModule } from "../../monitors/index.js";
import type { WorkspacesModule } from "../../workspaces/index.js";
import { createReportsRepository } from "../reports.repository.js";
import { createReportsService, weekStartOf, type ReportsService } from "../reports.service.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  signUpVerified,
} from "../../../__tests__/helpers/container-app.js";

const DAY = 86_400_000;
let ctx: ReturnType<typeof buildContainerApp>;
let owner: TestAgent;
let ownerEmail: string;
let ws: string;
let service: ReportsService;
const clock = createFakeClock();
/* Last week's Monday, so the fixtures fall inside the digest's week. */
const thisWeek = weekStartOf(new Date());
const lastWeek = new Date(thisWeek.getTime() - 7 * DAY);

const digests = () =>
  ctx.container.infra.db
    .execute<{
      payload: { to: string; data: Record<string, unknown>; headers: Record<string, string> };
    }>(
      sql`select payload from outbox_events where type = 'email.requested' and workspace_id = ${ws} and payload->>'template' = 'digest'`,
    )
    .then((r) => r.rows.map((row) => row.payload));

beforeAll(async () => {
  ctx = buildContainerApp();
  owner = request.agent(ctx.app);
  ownerEmail = `digest-${randomBytes(4).toString("hex")}@example.com`;
  await signUpVerified(ctx, owner, ownerEmail);
  const created = await owner
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "Digest Co", slug: `digest-co-${randomBytes(4).toString("hex")}` });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id;

  const monitor = await owner
    .post(`/api/w/${ws}/monitors`)
    .set("Origin", WEB_ORIGIN)
    .send({
      settings: { name: "Checkout API" },
      config: { type: "tcp", host: "example.com", port: 443 },
    });
  const monitorId = monitor.body.id as string;
  const db = ctx.container.infra.db;
  const started = new Date(lastWeek.getTime() + 2 * DAY);
  /* Two incidents last week, one resolved after 30 minutes; 30 minutes of outage. */
  await db.execute(sql`
    insert into incidents (id, workspace_id, number, source, monitor_id, title, severity, status, started_at, resolved_at)
    values
      (${newId()}, ${ws}, 9001, 'monitor', ${monitorId}, 'Checkout is down', 'high', 'resolved',
        ${started.toISOString()}::timestamptz, ${new Date(started.getTime() + 30 * 60_000).toISOString()}::timestamptz),
      (${newId()}, ${ws}, 9002, 'manual', null, 'Slow logins', 'low', 'triggered',
        ${new Date(started.getTime() + DAY).toISOString()}::timestamptz, null)`);
  await db.execute(sql`
    insert into downtimes (id, workspace_id, monitor_id, kind, started_at, ended_at)
    values (${newId()}, ${ws}, ${monitorId}, 'outage', ${started.toISOString()}::timestamptz,
      ${new Date(started.getTime() + 30 * 60_000).toISOString()}::timestamptz)`);

  const find = <T>(name: string) => ctx.container.modules.find((m) => m.name === name) as T;
  service = createReportsService({
    db,
    repository: createReportsRepository(),
    workspaces: find<WorkspacesModule>("workspaces").service,
    incidents: find<IncidentsModule>("incidents").service,
    detection: find<DetectionModule>("detection").service,
    monitors: find<MonitorsModule>("monitors").service,
    outbox: ctx.container.infra.outbox,
    clock,
    logger: ctx.container.infra.logger,
    webOrigin: WEB_ORIGIN,
  });
});

afterAll(async () => {
  await ctx.container.close();
});

describe("weekly digest", () => {
  it("waits until Monday 08:00 UTC", async () => {
    clock.set(new Date(thisWeek.getTime() + 7 * 3_600_000));
    expect(await service.sendWeeklyDigests()).toBe(0);
    expect(await service.sendDigest(ws)).toBe(false);
    expect(await digests()).toEqual([]);
  });

  it("sends last week's numbers to the owner once, with List-Unsubscribe", async () => {
    /* The sweep does this for every workspace; the shared test database has thousands. */
    clock.set(new Date(thisWeek.getTime() + 9 * 3_600_000));
    expect(await service.sendDigest(ws)).toBe(true);
    const [digest, ...rest] = await digests();
    expect(rest).toEqual([]);
    expect(digest?.to).toBe(ownerEmail);
    expect(digest?.data).toMatchObject({
      workspaceName: "Digest Co",
      weekStart: lastWeek.toISOString().slice(0, 10),
      incidents: 2,
      resolved: 1,
      mttrMinutes: 30,
      totalMonitors: 1,
      monitors: [{ name: "Checkout API", downtimeMinutes: 30 }],
    });
    expect(digest?.headers["List-Unsubscribe"]).toBe(`<${WEB_ORIGIN}/w/${ws}/settings>`);

    clock.set(new Date(thisWeek.getTime() + 2 * DAY));
    expect(await service.sendDigest(ws)).toBe(false);
    expect(await digests()).toHaveLength(1);
  });
});
