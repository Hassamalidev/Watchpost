/*
 * P2-T10 through the real API: a monitor's status, uptime and response-time badges. The URLs are
 * handed to people who may see the monitor, can't be guessed, follow the monitor, and a cached badge
 * is served in well under 50 ms.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { v7 as uuidv7 } from "uuid";
import { createFakeClock } from "../core/clock.js";
import type { BadgeLinks } from "../modules/badges/index.js";
import type { DetectionModule } from "../modules/detection/index.js";
import type { ProbesModule } from "../modules/probes/index.js";
import type { ResultsModule } from "../modules/results/index.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  probeClient,
  signUpVerified,
} from "./helpers/container-app.js";

/* The clock only moves when the test says so, which is how the one-minute cache is tested. */
const clock = createFakeClock(new Date());
const ctx = buildContainerApp({ authRateLimit: false, clock });
const run = randomBytes(4).toString("hex");
let owner: TestAgent;
let outsider: TestAgent;
let ws = "";
let monitorId = "";
let links: BadgeLinks;

const find = <T>(name: string) => ctx.container.modules.find((m) => m.name === name) as T;
/* The path of a badge URL, with an optional query. */
const pathOf = (url: string, query = "") => `${new URL(url).pathname}${query}`;
const badge = (url: string, query = "") => request(ctx.app).get(pathOf(url, query)).buffer(true);
const textOf = (res: { body: unknown; text?: string }) =>
  Buffer.isBuffer(res.body) ? res.body.toString("utf8") : (res.text ?? "");

let tick = 1_000;
async function settle(ok: boolean, latencyMs = 120) {
  const results = find<ResultsModule>("results");
  const detection = find<DetectionModule>("detection");
  for (let i = 0; i < 2; i += 1) {
    tick -= 1;
    await results.service.ingest([
      {
        id: uuidv7(),
        monitorId,
        workspaceId: ws,
        region: "eu-central",
        checkedAt: new Date(clock.now().getTime() - tick * 1_000).toISOString(),
        ok,
        latencyMs,
        ...(ok ? {} : { errorCode: "connect_refused" }),
      },
    ]);
    await ctx.container.infra.db.execute(sql`
      insert into monitor_state (monitor_id, workspace_id, last_result_at)
      values (${monitorId}, ${ws}, now())
      on conflict (monitor_id) do update set last_result_at = now()`);
    await detection.service.evaluateMonitor(monitorId);
  }
}

beforeAll(async () => {
  owner = request.agent(ctx.app);
  outsider = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `badge-${run}@example.com`);
  const created = await owner
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "Badges Co", slug: `badge-${run}` });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id as string;
  await signUpVerified(ctx, outsider, `badge-out-${run}@example.com`);
  await outsider
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "Other", slug: `badge-other-${run}` });

  const creds = await find<ProbesModule>("probes").service.register({
    name: `badge-${run}`,
    region: "eu-central",
    kind: "managed",
  });
  const hello = await probeClient(ctx.app, creds).call("POST", "/hello", {
    version: "0.1.0",
    mode: "managed",
    region: "eu-central",
    capabilities: ["tcp"],
  });
  expect(hello.status, hello.text).toBe(200);

  const monitor = await owner
    .post(`/api/w/${ws}/monitors`)
    .set("Origin", WEB_ORIGIN)
    .send({
      settings: { name: "API", regions: ["eu-central"], minFailingRegions: 1 },
      config: { type: "tcp", host: "example.com", port: 443 },
    });
  expect(monitor.status, monitor.text).toBe(201);
  monitorId = monitor.body.id as string;
}, 120_000);

afterAll(async () => {
  await ctx.container.infra.db.execute(sql`delete from probe_tasks where workspace_id = ${ws}`);
  await ctx.container.close();
});

describe("badge URLs", () => {
  it("are handed to people who may see the monitor, and to nobody else", async () => {
    const res = await owner
      .get(`/api/w/${ws}/monitors/${monitorId}/badges`)
      .set("Origin", WEB_ORIGIN);
    expect(res.status, res.text).toBe(200);
    links = res.body as BadgeLinks;
    expect(links.status).toMatch(
      new RegExp(`^${WEB_ORIGIN}/api/public/badges/${monitorId}\\.[A-Za-z0-9_-]{22}/status\\.svg$`),
    );
    expect(links.link).toBe(WEB_ORIGIN);

    const peek = await outsider
      .get(`/api/w/${ws}/monitors/${monitorId}/badges`)
      .set("Origin", WEB_ORIGIN);
    expect([403, 404]).toContain(peek.status);
    const signedOut = await request(ctx.app).get(`/api/w/${ws}/monitors/${monitorId}/badges`);
    expect(signedOut.status).toBe(401);
  });

  it("can't be guessed: the monitor's ID alone, or a changed signature, shows nothing", async () => {
    const forged = links.status.replace(/\.[A-Za-z0-9_-]{22}\//, `.${"A".repeat(22)}/`);
    const res = await badge(forged);
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/image\/svg\+xml/);
    expect(textOf(res)).toContain("not found");
    expect(res.headers["cache-control"]).toBe("no-store");
    const bare = await request(ctx.app).get(`/api/public/badges/${monitorId}/status.svg`);
    expect([400, 404]).toContain(bare.status);
    const unknownKind = await request(ctx.app).get(
      pathOf(links.status).replace("status.svg", "x.svg"),
    );
    expect(unknownKind.status).toBe(400);
  });
});

describe("what the badges say", () => {
  it("a monitor without results is pending, with no data", async () => {
    const status = await badge(links.status);
    expect(status.status).toBe(200);
    expect(status.headers["content-type"]).toMatch(/image\/svg\+xml/);
    expect(status.headers["cache-control"]).toBe("public, max-age=60, s-maxage=60");
    expect(status.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(status.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(textOf(status)).toContain('aria-label="status: pending"');
    expect(textOf(await badge(links.latency))).toContain('aria-label="response: no data"');
  });

  it("follows the monitor once the minute-long cache has passed", async () => {
    await settle(true, 120);
    /* Still the cached image. */
    expect(textOf(await badge(links.status))).toContain("status: pending");
    clock.advance(61_000);
    expect(textOf(await badge(links.status))).toContain('aria-label="status: up"');
    expect(textOf(await badge(links.latency))).toContain('aria-label="response: 120 ms"');
    expect(textOf(await badge(links.uptime))).toMatch(/aria-label="uptime 30d: [\d.]+%"/);

    await settle(false);
    clock.advance(61_000);
    const down = textOf(await badge(links.status));
    expect(down).toContain('aria-label="status: down"');
    expect(down).toContain("#cf222e");
    expect(textOf(await badge(links.uptime, "?days=7"))).toMatch(/aria-label="uptime 7d: [\d.]+%"/);

    const paused = await owner
      .post(`/api/w/${ws}/monitors/${monitorId}/pause`)
      .set("Origin", WEB_ORIGIN)
      .send({});
    expect(paused.status, paused.text).toBe(200);
    clock.advance(61_000);
    expect(textOf(await badge(links.status))).toContain('aria-label="status: paused"');
  }, 60_000);

  it("takes a custom label of plain words, and nothing else", async () => {
    expect(textOf(await badge(links.status, "?label=API%20status"))).toContain(
      'aria-label="API status: paused"',
    );
    expect((await badge(links.status, "?label=%3Cscript%3E")).status).toBe(400);
    expect((await badge(links.uptime, "?days=45")).status).toBe(400);
    expect((await badge(links.status, `?label=${"x".repeat(31)}`)).status).toBe(400);
  });

  it("a deleted monitor's badge says so instead of breaking", async () => {
    const extra = await owner
      .post(`/api/w/${ws}/monitors`)
      .set("Origin", WEB_ORIGIN)
      .send({
        settings: { name: "Gone", regions: ["eu-central"], minFailingRegions: 1 },
        config: { type: "tcp", host: "example.com", port: 443 },
      });
    const gone = (
      await owner.get(`/api/w/${ws}/monitors/${extra.body.id}/badges`).set("Origin", WEB_ORIGIN)
    ).body as BadgeLinks;
    await owner.delete(`/api/w/${ws}/monitors/${extra.body.id}`).set("Origin", WEB_ORIGIN);
    const res = await badge(gone.status);
    expect(res.status).toBe(200);
    expect(textOf(res)).toContain('aria-label="status: not found"');
  });
});

describe("speed", () => {
  it("serves a cached badge in under 50 ms", async () => {
    /*
     * Over one kept-alive connection to a listening server, as a CDN or a browser would ask, so the
     * time measured is the request and not the setup of a new connection each time.
     */
    const server = ctx.app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const urls = [links.status, links.uptime, links.latency].map(
        (url) => `http://127.0.0.1:${port}${pathOf(url)}`,
      );
      for (const url of urls) await (await fetch(url)).text();
      const timings: number[] = [];
      for (let i = 0; i < 60; i += 1) {
        const started = performance.now();
        const res = await fetch(urls[i % urls.length] ?? "");
        await res.text();
        timings.push(performance.now() - started);
        expect(res.status).toBe(200);
      }
      timings.sort((a, b) => a - b);
      const median = timings[Math.floor(timings.length / 2)] ?? Infinity;
      const p95 = timings[Math.floor(timings.length * 0.95)] ?? Infinity;
      process.stdout.write(
        `cached badge (ms): median ${median.toFixed(1)}, p95 ${p95.toFixed(1)}\n`,
      );
      /* The median is the claim; a loaded test machine can stretch single requests. */
      expect(median).toBeLessThan(50);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("a cached badge needs no database read", async () => {
    await badge(links.status);
    let acquired = 0;
    const count = () => {
      acquired += 1;
    };
    ctx.container.infra.pool.on("acquire", count);
    try {
      for (let i = 0; i < 20; i += 1) await badge(links.status);
    } finally {
      ctx.container.infra.pool.off("acquire", count);
    }
    expect(acquired).toBe(0);
  });
});
