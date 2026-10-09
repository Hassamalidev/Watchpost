/*
 * P6-T09 through the real app: Prometheus can scrape a workspace's monitors with an API key, and a
 * status page's overall state is available as a small public image.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { newId } from "../infra/ids.js";
import { prometheusText } from "../modules/badges/metrics.js";
import { WEB_ORIGIN, buildContainerApp, signUpVerified } from "./helpers/container-app.js";

const ctx = buildContainerApp({ authRateLimit: false });
const run = randomBytes(4).toString("hex");
let owner: TestAgent;
let ws = "";
let key = "";
let down = "";
let fresh = "";

const post = (path: string, body: object) =>
  owner.post(`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN).send(body);
const metrics = (apiKey: string | undefined) => {
  const req = request(ctx.app).get("/api/v1/metrics");
  return apiKey === undefined ? req : req.set("Authorization", `Bearer ${apiKey}`);
};

beforeAll(async () => {
  owner = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `prom-${run}@example.com`);
  const created = await owner
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "Prom Co", slug: `prom-${run}` });
  ws = created.body.id as string;
  key = (await post("/api-keys", { name: "prometheus", scopes: ["monitors:read"] })).body
    .key as string;
  const monitor = async (name: string) =>
    (
      await post("/monitors", {
        settings: { name },
        config: { type: "tcp", host: "example.com", port: 443 },
      })
    ).body.id as string;
  down = await monitor('Checkout "API"\\prod');
  fresh = await monitor("Just added");
  await post(`/monitors/${await monitor("Paused one")}/pause`, {});

  /* The first monitor has existed for two days, is down now, and was down for 36 minutes in the last day. */
  const db = ctx.container.infra.db;
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  await db.execute(
    sql`update monitors set created_at = ${iso(now - 2 * 86_400_000)}::timestamptz where id = ${down}`,
  );
  await db.execute(sql`
    insert into monitor_state (monitor_id, workspace_id, status, since)
    values (${down}, ${ws}, 'down', ${iso(now - 60_000)}::timestamptz)
    on conflict (monitor_id) do update set status = 'down'`);
  await db.execute(sql`
    insert into downtimes (id, workspace_id, monitor_id, kind, started_at, ended_at)
    values (${newId()}, ${ws}, ${down}, 'outage', ${iso(now - 4 * 3_600_000)}::timestamptz, ${iso(now - 4 * 3_600_000 + 36 * 60_000)}::timestamptz)`);
  const histogram = new Array<number>(31).fill(0);
  histogram[12] = 10;
  await db.execute(sql`
    insert into rollups_1h (monitor_id, region, bucket, workspace_id, count, fail_count, ok_count, latency_sum, latency_min, latency_max, histogram)
    values (${down}, 'eu-central', ${iso(Math.floor((now - 2 * 3_600_000) / 3_600_000) * 3_600_000)}::timestamptz, ${ws}, 12, 2, 10, 900, 80, 99, ${sql.raw(`array[${histogram.join(",")}]::int[]`)})`);
}, 120_000);

afterAll(async () => {
  await ctx.container.close();
});

describe("Prometheus metrics", () => {
  it("needs a key that may read monitors", async () => {
    expect((await metrics(undefined)).status).toBe(401);
    const other = (await post("/api-keys", { name: "incidents", scopes: ["incidents:read"] })).body
      .key as string;
    expect((await metrics(other)).status).toBe(403);
  });

  it("answers in the text format with each monitor's status, uptime and response time", async () => {
    const res = await metrics(key);
    expect(res.status, res.text).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8; version=0.0.4");
    const lines = res.text.split("\n");
    const labels = `monitor_id="${down}",monitor="Checkout \\"API\\"\\\\prod",type="tcp"`;
    expect(lines).toContain("# TYPE uptime_monitor_up gauge");
    expect(lines).toContain(`uptime_monitor_up{${labels}} 0`);
    expect(lines).toContain(`uptime_monitor_status{${labels},status="down"} 1`);
    /* 36 minutes of a day is 2.5 %: the same figure the monitor page shows. */
    expect(lines).toContain(`uptime_monitor_uptime_ratio{${labels},window="24h"} 0.975`);
    const calculator = await owner
      .get(
        `/api/w/${ws}/monitors/${down}/uptime?from=${new Date(Date.now() - 86_400_000).toISOString()}`,
      )
      .set("Origin", WEB_ORIGIN);
    expect(Math.round(calculator.body.uptimePercent)).toBe(98);
    expect(lines).toContain(
      `uptime_monitor_response_time_seconds{${labels},quantile="0.5"} 0.0875`,
    );
    expect(lines).toContain(`uptime_monitor_checks_24h{${labels}} 12`);

    /* A monitor that hasn't reported has a status but no up/down value; a paused one says so. */
    expect(res.text).toContain(`monitor="Just added",type="tcp",status="pending"} 1`);
    expect(res.text).not.toContain(`uptime_monitor_up{monitor_id="${fresh}"`);
    expect(res.text).toContain(`monitor="Paused one",type="tcp",status="paused"} 1`);
    expect(res.text).toContain(`monitor="Paused one",type="tcp"} 1`);
    expect(res.text.endsWith("\n")).toBe(true);
    /* Every line is a comment or `name{labels} number`. */
    for (const line of lines.filter((l) => l !== "")) {
      expect(line).toMatch(/^(# (HELP|TYPE) \w+ .+|\w+\{.*\} -?\d+(\.\d+)?)$/);
    }
  });

  it("is listed in the OpenAPI document as text", async () => {
    const doc = (await request(ctx.app).get("/api/v1/openapi.json")).body as {
      paths: Record<string, { get: { responses: Record<string, { content: object }> } }>;
    };
    expect(Object.keys(doc.paths["/metrics"]?.get.responses["200"]?.content ?? {})).toEqual([
      "text/plain",
    ]);
  });

  it("renders nothing but a newline for a workspace without monitors", () => {
    expect(prometheusText([])).toBe("\n");
  });
});

describe("status widget", () => {
  it("shows a published page's overall state as an image anyone can embed", async () => {
    const slug = `prom-${run}`;
    const page = await post("/status-pages", { name: "Prom status", slug, monitorIds: [fresh] });
    expect(page.status, page.text).toBe(201);
    const res = await request(ctx.app).get(`/api/public/status-widget/${slug}.svg`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/svg\+xml/);
    expect(res.headers["cache-control"]).toBe("public, max-age=60, s-maxage=60");
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    const svg = (res.body as Buffer).toString("utf8");
    expect(svg).toContain("<svg");
    expect(svg).toContain("all systems operational");

    const missing = await request(ctx.app).get(`/api/public/status-widget/no-such-page-${run}.svg`);
    expect(missing.status).toBe(404);
    expect((missing.body as Buffer).toString("utf8")).toContain("page not found");
    expect((await request(ctx.app).get("/api/public/status-widget/UPPER.svg")).status).toBe(400);
  });
});
