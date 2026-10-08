/*
 * P5-T05 through the real API: an SLA report's numbers are the SLA calculator's numbers (the
 * monitor uptime endpoint) for every monitor, on screen, in the CSV and in what a schedule emails;
 * a schedule sends a period once, its link opens the PDF without an account, and its unsubscribe
 * link takes the address off.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import type { ReportScheduleView, SlaReport } from "@app/shared";
import { createFakeClock } from "../core/clock.js";
import { newId } from "../infra/ids.js";
import type { ReportsModule } from "../modules/reports/index.js";
import { WEB_ORIGIN, buildContainerApp, signUpVerified } from "./helpers/container-app.js";

const MINUTE = 60_000;
const DAY = 86_400_000;
/* Reports go out from 08:00 UTC on the 1st, so the clock never sits in the hours before that. */
const real = new Date();
const thisMonth = new Date(Date.UTC(real.getUTCFullYear(), real.getUTCMonth(), 1));
const clock = createFakeClock(
  new Date(Math.max(real.getTime(), thisMonth.getTime() + 9 * 3_600_000)),
);
/* The report's period: all of last month. */
const from = new Date(Date.UTC(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth() - 1, 1));
const to = thisMonth;
const period = `from=${from.toISOString()}&to=${to.toISOString()}`;

const ctx = buildContainerApp({ authRateLimit: false, clock });
const run = randomBytes(4).toString("hex");
const ownerEmail = `sla-${run}@example.com`;
let owner: TestAgent;
let ws = "";
let checkout = "";
let search = "";
let group = "";
let page = "";

const get = (path: string) => owner.get(`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN);
const send = (method: "post" | "put" | "delete", path: string) =>
  owner[method](`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN);
const iso = (ms: number) => new Date(ms).toISOString();
const reports = () =>
  (ctx.container.modules.find((m) => m.name === "reports") as ReportsModule).service;

const reportEmails = () =>
  ctx.container.infra.db
    .execute<{
      payload: { to: string; data: Record<string, unknown>; headers: Record<string, string> };
    }>(
      sql`select payload from outbox_events where type = 'email.requested' and workspace_id = ${ws} and payload->>'template' = 'sla-report' order by created_at`,
    )
    .then((r) => r.rows.map((row) => row.payload));

/* A paid Business subscription, written as the billing module stores one. */
async function subscribeToBusiness() {
  const start = iso(clock.now().getTime() - DAY);
  const end = iso(clock.now().getTime() + 29 * DAY);
  await ctx.container.infra.db.execute(sql`
    insert into subscriptions (id, workspace_id, paddle_subscription_id, paddle_customer_id, status,
      plan_key, billing_interval, items, period_start, period_end, paid_period_start, paid_period_end,
      last_event_at)
    values (${newId()}, ${ws}, ${`sub_${run}`}, ${`ctm_${run}`}, 'active', 'business', 'month',
      '[]'::jsonb, ${start}::timestamptz, ${end}::timestamptz, ${start}::timestamptz, ${end}::timestamptz,
      ${start}::timestamptz)`);
  const plan = await get("/entitlements");
  expect(plan.body.plan, plan.text).toBe("business");
}

const asBuffer = (res: request.Response, done: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  res.on("end", () => done(null, Buffer.concat(chunks)));
};

beforeAll(async () => {
  owner = request.agent(ctx.app);
  await signUpVerified(ctx, owner, ownerEmail);
  const created = await owner
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "SLA Co", slug: `sla-${run}` });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id as string;

  const made = await send("post", "/monitor-groups").send({ name: "Shop" });
  expect(made.status, made.text).toBe(201);
  group = made.body.id as string;
  const monitor = async (name: string, groupId?: string) => {
    const res = await send("post", "/monitors").send({
      settings: { name, ...(groupId === undefined ? {} : { groupId }) },
      config: { type: "tcp", host: "example.com", port: 443 },
    });
    expect(res.status, res.text).toBe(201);
    return res.body.id as string;
  };
  checkout = await monitor("Checkout API", group);
  /* A name a spreadsheet would run as a formula. */
  search = await monitor("=SUM(A1)");
  const status = await send("post", "/status-pages").send({
    name: "Search status",
    slug: `sla-${run}`,
    monitorIds: [search],
  });
  expect(status.status, status.text).toBe(201);
  page = status.body.id as string;

  const db = ctx.container.infra.db;
  /* Both monitors existed for the whole period. */
  await db.execute(
    sql`update monitors set created_at = ${iso(from.getTime() - 10 * DAY)}::timestamptz where workspace_id = ${ws}`,
  );
  const at = from.getTime();
  const downtime = (kind: string, start: number, minutes: number) => sql`
    (${newId()}, ${ws}, ${checkout}, ${kind}, ${iso(start)}::timestamptz, ${iso(start + minutes * MINUTE)}::timestamptz)`;
  /*
   * Checkout: a 90-minute outage, an hour-long outage that began 30 minutes before the period (30
   * minutes count), and 30 minutes of maintenance. 120 minutes of downtime in all.
   */
  await db.execute(sql`
    insert into downtimes (id, workspace_id, monitor_id, kind, started_at, ended_at) values
    ${downtime("outage", at + 2 * DAY, 90)},
    ${downtime("outage", at - 30 * MINUTE, 60)},
    ${downtime("maintenance", at + 5 * DAY, 30)}`);
  const incident = (
    number: number,
    source: string,
    start: number,
    ackMinutes: number | null,
    resolveMinutes: number,
  ) => sql`
    (${newId()}, ${ws}, ${number}, ${source}, ${checkout}, 'Checkout is down', 'high', 'resolved',
      ${iso(start)}::timestamptz,
      ${ackMinutes === null ? null : iso(start + ackMinutes * MINUTE)}::timestamptz,
      ${iso(start + resolveMinutes * MINUTE)}::timestamptz)`;
  /* Two incidents count; the drill and the one before the period don't. */
  await db.execute(sql`
    insert into incidents (id, workspace_id, number, source, monitor_id, title, severity, status, started_at, acked_at, resolved_at) values
    ${incident(9001, "monitor", at + 2 * DAY, 5, 90)},
    ${incident(9002, "monitor", at + 10 * DAY, null, 30)},
    ${incident(9003, "drill", at + 11 * DAY, 1, 2)},
    ${incident(9004, "monitor", at - 3 * DAY, 1, 2)}`);
  /* Hourly rollups from two regions: 20 checks, 18 successful; 10 near 80 ms and 8 near 450 ms. */
  const histogram = (fast: number, slow: number) => {
    const h = new Array<number>(31).fill(0);
    h[12] = fast;
    h[17] = slow;
    return sql.raw(`array[${h.join(",")}]::int[]`);
  };
  await db.execute(sql`
    insert into rollups_1h (monitor_id, region, bucket, workspace_id, count, fail_count, ok_count, latency_sum, latency_min, latency_max, histogram) values
    (${checkout}, 'eu-central', ${iso(at + 2 * DAY)}::timestamptz, ${ws}, 10, 1, 9, 2200, 70, 460, ${histogram(5, 4)}),
    (${checkout}, 'us-east', ${iso(at + 2 * DAY)}::timestamptz, ${ws}, 10, 1, 9, 2200, 70, 460, ${histogram(5, 4)}),
    (${checkout}, 'us-east', ${iso(to.getTime() + DAY)}::timestamptz, ${ws}, 50, 0, 50, 99999, 70, 9000, ${histogram(0, 50)})`);
}, 180_000);

afterAll(async () => {
  await ctx.container.infra.db.execute(
    sql`delete from report_schedules where workspace_id = ${ws}`,
  );
  await ctx.container.close();
});

describe("SLA reports", () => {
  it("every monitor's numbers are the SLA calculator's, with and without maintenance", async () => {
    for (const excludeMaintenance of [true, false]) {
      const res = await get(`/reports/sla?${period}&excludeMaintenance=${excludeMaintenance}`);
      expect(res.status, res.text).toBe(200);
      const report = res.body as SlaReport;
      expect(report.rows.map((r) => r.name)).toEqual(["=SUM(A1)", "Checkout API"]);
      for (const row of report.rows) {
        const calculator = await get(
          `/monitors/${row.monitorId}/uptime?${period}&excludeMaintenance=${excludeMaintenance}`,
        );
        expect(calculator.status, calculator.text).toBe(200);
        expect({
          uptimePercent: row.uptimePercent,
          rangeSeconds: row.rangeSeconds,
          downtimeSeconds: row.downtimeSeconds,
          maintenanceSeconds: row.maintenanceSeconds,
        }).toEqual({
          uptimePercent: calculator.body.uptimePercent,
          rangeSeconds: calculator.body.rangeSeconds,
          downtimeSeconds: calculator.body.downtimeSeconds,
          maintenanceSeconds: calculator.body.maintenanceSeconds,
        });
      }
      /* And they are the numbers we put in: 120 minutes of outage, 30 of maintenance. */
      const row = report.rows.find((r) => r.monitorId === checkout);
      const range = (to.getTime() - from.getTime()) / 1_000;
      const down = excludeMaintenance ? 7_200 : 9_000;
      const time = excludeMaintenance ? range - 1_800 : range;
      expect(row).toMatchObject({
        rangeSeconds: range,
        downtimeSeconds: down,
        maintenanceSeconds: 1_800,
        uptimePercent: Math.round((1 - down / time) * 1_000_000) / 10_000,
      });
      expect(report.rows.find((r) => r.monitorId === search)).toMatchObject({
        uptimePercent: 100,
        downtimeSeconds: 0,
        incidents: 0,
        mttaSeconds: null,
        p50: null,
      });
      /* The total is all downtime over all time, by the same rule. */
      expect(report.totals).toMatchObject({
        rangeSeconds: 2 * range,
        downtimeSeconds: down,
        uptimePercent: Math.round((1 - down / (time + range)) * 1_000_000) / 10_000,
      });
    }
  });

  it("counts incidents, response times and latency for the period only", async () => {
    const report = (await get(`/reports/sla?${period}`)).body as SlaReport;
    const row = report.rows.find((r) => r.monitorId === checkout);
    expect(row).toMatchObject({
      incidents: 2,
      /* One of the two was acknowledged, after 5 minutes; they took 90 and 30 minutes to resolve. */
      mttaSeconds: 300,
      mttrSeconds: 3_600,
      checks: 20,
      /* 10 of 18 successful checks are in the 75–100 ms bucket, the rest in 400–500 ms. */
      p50: 97.5,
      p95: 500,
      p99: 500,
    });
    expect(report.totals).toMatchObject({ incidents: 2, mttaSeconds: 300, mttrSeconds: 3_600 });
    expect(report.target).toEqual({ kind: "workspace", id: null, name: "All monitors" });
    expect(report.workspaceName).toBe("SLA Co");
  });

  it("reports on one monitor, a group or a status page's monitors", async () => {
    const names = async (query: string) => {
      const res = await get(`/reports/sla?${period}&${query}`);
      expect(res.status, res.text).toBe(200);
      const report = res.body as SlaReport;
      return { target: report.target.name, rows: report.rows.map((r) => r.name) };
    };
    expect(await names(`kind=monitor&id=${checkout}`)).toEqual({
      target: "Checkout API",
      rows: ["Checkout API"],
    });
    expect(await names(`kind=group&id=${group}`)).toEqual({
      target: "Shop",
      rows: ["Checkout API"],
    });
    expect(await names(`kind=page&id=${page}`)).toEqual({
      target: "Search status",
      rows: ["=SUM(A1)"],
    });
  });

  it("refuses periods and targets that make no report", async () => {
    expect(
      (await get(`/reports/sla?from=${to.toISOString()}&to=${from.toISOString()}`)).status,
    ).toBe(400);
    expect((await get(`/reports/sla?${period}&kind=group`)).status).toBe(400);
    expect((await get(`/reports/sla?${period}&id=${group}`)).status).toBe(400);
    expect((await get(`/reports/sla?${period}&kind=group&id=${newId()}`)).status).toBe(404);
    expect((await get(`/reports/sla?${period}&kind=monitor&id=${newId()}`)).status).toBe(404);
    const longAgo = new Date(from.getTime() - 400 * DAY).toISOString();
    expect((await get(`/reports/sla?from=${longAgo}&to=${to.toISOString()}`)).status).toBe(400);
  });

  it("the CSV holds the same numbers, and a name can't become a formula", async () => {
    const report = (await get(`/reports/sla?${period}`)).body as SlaReport;
    const res = await get(`/reports/sla.csv?${period}`);
    expect(res.status, res.text).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(
      /^attachment; filename="sla-report-.*\.csv"$/,
    );
    const lines = res.text.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "Monitor,Type,Uptime %,Downtime seconds,Maintenance seconds,Incidents,MTTA seconds,MTTR seconds,p50 ms,p95 ms,p99 ms,Checks",
    );
    const row = report.rows.find((r) => r.monitorId === checkout);
    expect(lines).toContain(
      `Checkout API,tcp,${row?.uptimePercent},7200,1800,2,300,3600,97.5,500,500,20`,
    );
    expect(lines).toContain("'=SUM(A1),tcp,100,0,0,0,,,,,,0");
    expect(lines.at(-1)).toBe(
      `All monitors,,${report.totals.uptimePercent},7200,1800,2,300,3600,97.5,500,500,20`,
    );
    expect(lines).toHaveLength(4);
  });

  it("downloads as a PDF; our name comes off it only on Business", async () => {
    const pdf = (query: string) =>
      get(`/reports/sla.pdf?${period}&kind=group&id=${group}${query}`).buffer(true).parse(asBuffer);
    const plain = await pdf("");
    expect(plain.status).toBe(200);
    expect(plain.headers["content-type"]).toMatch(/application\/pdf/);
    expect((plain.body as Buffer).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect((plain.body as Buffer).length).toBeGreaterThan(1_500);

    /* The workspace is on the Pro trial: files yes, white-label no. */
    const refused = await get(`/reports/sla.pdf?${period}&brand=Acme%20Agency`);
    expect(refused.status).toBe(402);
    expect(refused.body.detail).toMatch(/Business plan/);
    const body = {
      name: "Client report",
      target: { kind: "workspace" },
      frequency: "monthly",
      recipients: ["client@example.com"],
      brandName: "Acme Agency",
    };
    expect((await send("post", "/reports/schedules").send(body)).status).toBe(402);

    await subscribeToBusiness();
    expect((await pdf("&brand=Acme%20Agency")).status).toBe(200);
  }, 60_000);
});

describe("scheduled reports", () => {
  let schedule: ReportScheduleView;

  it("a schedule is created with clean recipients and checked against the workspace", async () => {
    const body = {
      name: "Client report",
      target: { kind: "group", id: group },
      frequency: "monthly",
      recipients: ["Client@Example.com", "client@example.com", "boss@example.com"],
      brandName: "Acme Agency",
    };
    const res = await send("post", "/reports/schedules").send(body);
    expect(res.status, res.text).toBe(201);
    schedule = res.body as ReportScheduleView;
    expect(schedule).toMatchObject({
      name: "Client report",
      target: { kind: "group", id: group, name: "Shop" },
      recipients: ["client@example.com", "boss@example.com"],
      excludeMaintenance: true,
      brandName: "Acme Agency",
      lastPeriodStart: null,
    });
    expect((await get("/reports/schedules")).body.data).toEqual([schedule]);

    const bad = async (patch: Record<string, unknown>) =>
      (await send("post", "/reports/schedules").send({ ...body, ...patch })).status;
    expect(await bad({ target: { kind: "group", id: newId() } })).toBe(404);
    expect(await bad({ target: { kind: "group" } })).toBe(400);
    expect(await bad({ recipients: [] })).toBe(400);
    expect(await bad({ recipients: ["not-an-address"] })).toBe(400);
    expect(
      await bad({ recipients: Array.from({ length: 11 }, (_, i) => `p${i}@example.com`) }),
    ).toBe(400);
  });

  it("the first report covers the period the schedule was created in, not an earlier one", async () => {
    await reports().sendScheduledReports();
    expect(await reportEmails()).toEqual([]);
  });

  it("sends last month once to every recipient, with the report's numbers", async () => {
    /* As if the schedule had been made during last month. */
    await ctx.container.infra.db.execute(
      sql`update report_schedules set created_at = ${iso(from.getTime() + DAY)}::timestamptz where id = ${schedule.id}`,
    );
    expect(await reports().sendScheduledReports()).toBeGreaterThanOrEqual(1);
    const emails = await reportEmails();
    expect(emails.map((e) => e.to).sort()).toEqual(["boss@example.com", "client@example.com"]);
    const report = (await get(`/reports/sla?${period}&kind=group&id=${group}`)).body as SlaReport;
    for (const email of emails) {
      expect(email.data).toMatchObject({
        heading: "Client report",
        subject: "Shop",
        uptimePercent: report.totals.uptimePercent,
        downtimeMinutes: 120,
        incidents: 2,
        monitorCount: 1,
        brand: "Acme Agency",
        worst: [{ name: "Checkout API", downtimeMinutes: 120 }],
      });
      expect(email.headers["List-Unsubscribe"]).toBe(`<${String(email.data.unsubscribeUrl)}>`);
      expect(email.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    }
    expect((await get("/reports/schedules")).body.data[0].lastPeriodStart).toBe(from.toISOString());

    await reports().sendScheduledReports();
    expect(await reportEmails()).toHaveLength(2);
  }, 60_000);

  it("the emailed link opens the PDF without an account; a changed link doesn't", async () => {
    const [email] = await reportEmails();
    const path = String(email?.data.url).slice(WEB_ORIGIN.length);
    expect(path).toMatch(/^\/api\/public\/reports\/[\w.-]+\/sla\.pdf$/);
    const res = await request(ctx.app).get(path).buffer(true).parse(asBuffer);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect((res.body as Buffer).subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const forged = path.replace(/.(\/sla\.pdf)$/, "x$1");
    expect((await request(ctx.app).get(forged)).status).toBe(404);
  }, 60_000);

  it("an unsubscribe link takes that address off the schedule", async () => {
    const emails = await reportEmails();
    const link = (to: string) =>
      String(emails.find((e) => e.to === to)?.data.unsubscribeUrl).slice(WEB_ORIGIN.length);
    const page = await request(ctx.app).get(link("client@example.com"));
    expect(page.status).toBe(200);
    expect(page.text).toContain("You are unsubscribed");
    expect((await get("/reports/schedules")).body.data[0].recipients).toEqual(["boss@example.com"]);

    /* The mail app's own button posts to the same address. */
    const oneClick = await request(ctx.app).post(link("boss@example.com"));
    expect(oneClick.status).toBe(200);
    expect((await get("/reports/schedules")).body.data[0].recipients).toEqual([]);
    expect(
      (await request(ctx.app).get("/api/public/reports/unsubscribe?token=" + "x".repeat(40)))
        .status,
    ).toBe(404);
  });

  it("is edited and deleted", async () => {
    const edited = await send("put", `/reports/schedules/${schedule.id}`).send({
      name: "Weekly check",
      target: { kind: "workspace" },
      frequency: "weekly",
      recipients: ["boss@example.com"],
      excludeMaintenance: false,
    });
    expect(edited.status, edited.text).toBe(200);
    expect(edited.body).toMatchObject({
      name: "Weekly check",
      target: { kind: "workspace", id: null, name: "All monitors" },
      frequency: "weekly",
      excludeMaintenance: false,
      brandName: null,
    });
    expect((await send("delete", `/reports/schedules/${schedule.id}`)).status).toBe(204);
    expect((await send("delete", `/reports/schedules/${schedule.id}`)).status).toBe(404);
    expect((await get("/reports/schedules")).body.data).toEqual([]);
  });
});

describe("monthly uptime email", () => {
  it("goes to the owner once per month with the workspace's numbers", async () => {
    const before = (await reportEmails()).length;
    expect(await reports().sendMonthlyEmail(ws)).toBe(true);
    const email = (await reportEmails()).at(-1);
    expect(email?.to).toBe(ownerEmail);
    expect(email?.data).toMatchObject({
      heading: "Monthly uptime report",
      subject: "SLA Co",
      downtimeMinutes: 120,
      incidents: 2,
      monitorCount: 2,
      brand: null,
      url: `${WEB_ORIGIN}/w/${ws}/reports`,
    });
    expect(await reports().sendMonthlyEmail(ws)).toBe(false);
    expect(await reportEmails()).toHaveLength(before + 1);
  });
});
