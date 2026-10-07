/*
 * P2-T07 through the real API: a status page with components, what the public sees (status, uptime
 * bars, incidents, maintenance, feeds), who may edit it, and that every change tells the web app to
 * drop its cached copy.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { v7 as uuidv7 } from "uuid";
import type { PublicStatusPage, StatusIncidentView, StatusPageView } from "@app/shared";
import {
  WEB_ORIGIN,
  buildContainerApp,
  emailFromOutbox,
  probeClient,
  signUpVerified,
} from "./helpers/container-app.js";
import type { DetectionModule } from "../modules/detection/index.js";
import type { ProbesModule } from "../modules/probes/index.js";
import type { ResultsModule } from "../modules/results/index.js";
import type { StatuspagesModule } from "../modules/statuspages/index.js";

const refreshed: string[][] = [];
const ctx = buildContainerApp({
  authRateLimit: false,
  revalidate: async (tags) => {
    refreshed.push(tags);
  },
});
const run = randomBytes(4).toString("hex");
const slug = `acme-${run}`;
let owner: TestAgent;
let viewer: TestAgent;
let outsider: TestAgent;
let ws = "";
let page: StatusPageView;
let apiMonitor = "";
let webMonitor = "";

const as = (agent: TestAgent) => ({
  get: (path: string) => agent.get(`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN),
  post: (path: string, body: object) =>
    agent.post(`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN).send(body),
  patch: (path: string, body: object) =>
    agent.patch(`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN).send(body),
  put: (path: string, body: object) =>
    agent.put(`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN).send(body),
  delete: (path: string) => agent.delete(`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN),
});
const find = <T>(name: string) => ctx.container.modules.find((m) => m.name === name) as T;
const publicPage = async (ref = slug) => request(ctx.app).get(`/api/public/status/${ref}`);
const tagsSince = (mark: number) => refreshed.slice(mark).flat();

async function createMonitor(name: string): Promise<string> {
  const res = await as(owner).post("/monitors", {
    settings: { name, regions: ["eu-central"], minFailingRegions: 1 },
    config: { type: "tcp", host: "example.com", port: 443 },
  });
  expect(res.status, res.text).toBe(201);
  return res.body.id as string;
}

/* Two results in a row and an evaluation after each: enough to change the monitor's state. */
let tick = 1_000;
async function settle(monitorId: string, ok: boolean) {
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
        checkedAt: new Date(Date.now() - tick * 1_000).toISOString(),
        ok,
        latencyMs: 20,
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
  viewer = request.agent(ctx.app);
  outsider = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `sp-${run}@example.com`);
  const created = await owner
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "Acme", slug: `sp-${run}` });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id as string;

  const viewerEmail = `sp-viewer-${run}@example.com`;
  await signUpVerified(ctx, viewer, viewerEmail);
  await owner
    .post("/api/auth/organization/invite-member")
    .set("Origin", WEB_ORIGIN)
    .send({ email: viewerEmail, role: "viewer", organizationId: ws });
  const { url } = await emailFromOutbox(ctx.container, viewerEmail, "invite");
  await viewer
    .post("/api/auth/organization/accept-invitation")
    .set("Origin", WEB_ORIGIN)
    .send({ invitationId: String(url).split("/").at(-1) });

  await signUpVerified(ctx, outsider, `sp-out-${run}@example.com`);
  await outsider
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "Other", slug: `sp-other-${run}` });

  const creds = await find<ProbesModule>("probes").service.register({
    name: `sp-${run}`,
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

  apiMonitor = await createMonitor("API");
  webMonitor = await createMonitor("Website");
}, 120_000);

afterAll(async () => {
  await ctx.container.infra.db.execute(sql`delete from probe_tasks where workspace_id = ${ws}`);
  await ctx.container.close();
});

describe("pages", () => {
  it("is created from monitors, one component each, and is public at once", async () => {
    const mark = refreshed.length;
    const res = await as(owner).post("/status-pages", {
      name: "Acme",
      slug,
      monitorIds: [apiMonitor, webMonitor],
      branding: { description: "Live status of Acme's services.", accentColor: "#2563eb" },
    });
    expect(res.status, res.text).toBe(201);
    page = res.body as StatusPageView;
    expect(page).toMatchObject({
      name: "Acme",
      slug,
      url: `${WEB_ORIGIN}/s/${slug}`,
      published: true,
      settings: { showUptime: true },
    });
    expect(page.components.map((c) => [c.name, c.monitorId])).toEqual([
      ["API", apiMonitor],
      ["Website", webMonitor],
    ]);
    expect(tagsSince(mark)).toContain(`status-page:${slug}`);

    const seen = await publicPage();
    expect(seen.status, seen.text).toBe(200);
    expect(seen.headers["cache-control"]).toBe("public, max-age=5");
    expect(seen.headers["access-control-allow-origin"]).toBe("*");
    const body = seen.body as PublicStatusPage;
    expect(body.page).toMatchObject({ name: "Acme", slug });
    expect(body.page.branding.accentColor).toBe("#2563eb");
    /* Nothing has been checked yet, so nothing is claimed. */
    expect(body.components.map((c) => c.status)).toEqual(["unknown", "unknown"]);
    expect(body.status).toBe("operational");
    expect(body.components[0]?.uptime?.days).toHaveLength(90);
    expect(JSON.stringify(body)).not.toContain(apiMonitor);
    expect(JSON.stringify(body)).not.toContain(ws);
  });

  it("refuses a taken or reserved address, and another workspace's monitors", async () => {
    const taken = await as(owner).post("/status-pages", { name: "Again", slug });
    /* The Free plan allows one page, so the limit answers before the address does. */
    expect([402, 409]).toContain(taken.status);
    const reserved = await as(owner).post("/status-pages", { name: "Nope", slug: "www" });
    expect(reserved.status).toBe(400);
    const other = await outsider.get("/api/auth/organization/list").set("Origin", WEB_ORIGIN);
    const otherWs = (other.body as { id: string }[])[0]?.id ?? "";
    const stolen = await outsider
      .post(`/api/w/${otherWs}/status-pages`)
      .set("Origin", WEB_ORIGIN)
      .send({ name: "Theirs", slug: `theirs-${run}`, monitorIds: [apiMonitor] });
    expect(stolen.status).toBe(400);
    const sameSlug = await outsider
      .post(`/api/w/${otherWs}/status-pages`)
      .set("Origin", WEB_ORIGIN)
      .send({ name: "Theirs", slug });
    expect(sameSlug.status).toBe(409);
    expect(sameSlug.body.detail).toMatch(/taken/);
    /* And they can't read or change ours. */
    const peek = await outsider
      .get(`/api/w/${ws}/status-pages/${page.id}`)
      .set("Origin", WEB_ORIGIN);
    expect([403, 404]).toContain(peek.status);
  });

  it("viewers read; they can't edit or post", async () => {
    expect((await as(viewer).get("/status-pages")).body.data).toHaveLength(1);
    expect((await as(viewer).get(`/status-pages/${page.id}/preview`)).status).toBe(200);
    expect((await as(viewer).patch(`/status-pages/${page.id}`, { name: "x" })).status).toBe(403);
    expect(
      (
        await as(viewer).post(`/status-pages/${page.id}/incidents`, {
          title: "x",
          message: "x",
        })
      ).status,
    ).toBe(403);
  });

  it("components are replaced as an ordered list, with manual ones and groups", async () => {
    const [api, web] = page.components;
    const res = await as(owner).put(`/status-pages/${page.id}/components`, {
      components: [
        { id: web?.id, name: "Website", monitorId: webMonitor, group: "Customer facing" },
        { id: api?.id, name: "Public API", monitorId: apiMonitor, group: "Customer facing" },
        { name: "Support desk", manualStatus: "degraded", description: "Email and chat" },
      ],
    });
    expect(res.status, res.text).toBe(200);
    page = res.body as StatusPageView;
    expect(page.components.map((c) => c.name)).toEqual(["Website", "Public API", "Support desk"]);
    expect(page.components[0]?.id).toBe(web?.id);
    expect(page.components[2]).toMatchObject({ monitorId: null, manualStatus: "degraded" });

    const body = (await publicPage()).body as PublicStatusPage;
    expect(body.components.map((c) => [c.name, c.status, c.group])).toEqual([
      ["Website", "unknown", "Customer facing"],
      ["Public API", "unknown", "Customer facing"],
      ["Support desk", "degraded", null],
    ]);
    expect(body.components[2]?.uptime).toBeNull();
    expect(body.status).toBe("degraded");

    const foreign = await as(owner).put(`/status-pages/${page.id}/components`, {
      components: [{ id: uuidv7(), name: "Ghost" }],
    });
    expect(foreign.status).toBe(400);
  });
});

describe("what the public sees", () => {
  it("follows the monitors: an outage shows at once and the web app is told", async () => {
    await settle(apiMonitor, true);
    await settle(webMonitor, true);
    let body = (await publicPage()).body as PublicStatusPage;
    expect(body.components.slice(0, 2).map((c) => c.status)).toEqual([
      "operational",
      "operational",
    ]);

    await settle(apiMonitor, false);
    body = (await publicPage()).body as PublicStatusPage;
    expect(body.components.find((c) => c.name === "Public API")?.status).toBe("major_outage");
    expect(body.status).toBe("partial_outage");

    /* What the worker does with the event: refresh the pages that show the monitor. */
    const mark = refreshed.length;
    const statuspages = find<StatuspagesModule>("statuspages");
    expect(await statuspages.service.onMonitorChanged(apiMonitor)).toBe(1);
    expect(tagsSince(mark)).toEqual([`status-page:${slug}`]);
    expect(await statuspages.service.onMonitorChanged(uuidv7())).toBe(0);

    const [event] = (
      await ctx.container.infra.db.execute<{ n: number }>(sql`
        select count(*)::int as n from outbox_events
        where workspace_id = ${ws} and type = 'monitor.state_changed'
          and payload->>'monitorId' = ${apiMonitor} and payload->>'to' = 'down'`)
    ).rows;
    expect(event?.n).toBe(1);

    await settle(apiMonitor, true);
    body = (await publicPage()).body as PublicStatusPage;
    expect(body.components.find((c) => c.name === "Public API")?.status).toBe("operational");
    /* Today's bar remembers the outage. */
    const today = body.components.find((c) => c.name === "Public API")?.uptime?.days.at(-1);
    expect(today?.date).toBe(new Date().toISOString().slice(0, 10));
    expect(today?.uptimePercent).not.toBeNull();
  }, 120_000);

  it("an incident with updates: shown, affects its components, and ends when resolved", async () => {
    const website = page.components[0]?.id ?? "";
    const mark = refreshed.length;
    const created = await as(owner).post(`/status-pages/${page.id}/incidents`, {
      title: "Slow page loads",
      impact: "degraded",
      message: "We are looking into slow page loads.",
      componentIds: [website],
    });
    expect(created.status, created.text).toBe(201);
    const incident = created.body as StatusIncidentView;
    expect(incident).toMatchObject({ status: "investigating", published: true, auto: false });
    expect(incident.updates).toHaveLength(1);
    expect(tagsSince(mark)).toContain(`status-page:${slug}`);

    let body = (await publicPage()).body as PublicStatusPage;
    expect(body.incidents.active).toHaveLength(1);
    expect(body.incidents.active[0]).toMatchObject({
      title: "Slow page loads",
      components: ["Website"],
    });
    expect(body.components[0]?.status).toBe("degraded");

    const update = await as(owner).post(
      `/status-pages/${page.id}/incidents/${incident.id}/updates`,
      { status: "identified", message: "A cache server is overloaded." },
    );
    expect(update.status, update.text).toBe(201);
    expect((update.body as StatusIncidentView).updates.map((u) => u.status)).toEqual([
      "identified",
      "investigating",
    ]);

    const resolved = await as(owner).post(
      `/status-pages/${page.id}/incidents/${incident.id}/updates`,
      { status: "resolved", message: "Page loads are back to normal." },
    );
    expect((resolved.body as StatusIncidentView).resolvedAt).not.toBeNull();
    body = (await publicPage()).body as PublicStatusPage;
    expect(body.incidents.active).toEqual([]);
    expect(body.incidents.recent[0]?.updates).toHaveLength(3);
    expect(body.components[0]?.status).toBe("operational");

    /* Each published update is an event (subscribers hear about it from there). */
    const [events] = (
      await ctx.container.infra.db.execute<{ n: number }>(sql`
        select count(*)::int as n from outbox_events
        where workspace_id = ${ws} and type = 'status_page.update_published'`)
    ).rows;
    expect(events?.n).toBe(3);

    const elsewhere = await as(owner).post(`/status-pages/${page.id}/incidents`, {
      title: "x",
      message: "x",
      componentIds: [uuidv7()],
    });
    expect(elsewhere.status).toBe(400);
  });

  it("a draft incident stays private until it is published", async () => {
    const draft = await as(owner).post(`/status-pages/${page.id}/incidents`, {
      title: "Planned failover",
      message: "Draft text.",
      impact: "major_outage",
      componentIds: [page.components[1]?.id ?? ""],
      published: false,
    });
    expect(draft.status, draft.text).toBe(201);
    let body = (await publicPage()).body as PublicStatusPage;
    expect(body.incidents.active).toEqual([]);
    expect(body.components[1]?.status).toBe("operational");
    /* The team's preview shows it. */
    const preview = (await as(owner).get(`/status-pages/${page.id}/preview`))
      .body as PublicStatusPage;
    expect(preview.incidents.active.map((i) => i.title)).toEqual(["Planned failover"]);

    const published = await as(owner).patch(`/status-pages/${page.id}/incidents/${draft.body.id}`, {
      published: true,
    });
    expect(published.status, published.text).toBe(200);
    body = (await publicPage()).body as PublicStatusPage;
    expect(body.incidents.active.map((i) => i.title)).toEqual(["Planned failover"]);
    expect(body.components[1]?.status).toBe("major_outage");

    expect(
      (await as(owner).delete(`/status-pages/${page.id}/incidents/${draft.body.id}`)).status,
    ).toBe(204);
    body = (await publicPage()).body as PublicStatusPage;
    expect(body.incidents.active).toEqual([]);
  });

  it("scheduled maintenance of the page's monitors is announced", async () => {
    const window = await as(owner).post("/maintenance-windows", {
      name: "Database upgrade",
      startsAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      endsAt: new Date(Date.now() + 2 * 86_400_000 + 3_600_000).toISOString(),
      scope: { monitorIds: [apiMonitor] },
    });
    expect(window.status, window.text).toBe(201);
    const hidden = await as(owner).post("/maintenance-windows", {
      name: "Internal only",
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      endsAt: new Date(Date.now() + 86_400_000 + 3_600_000).toISOString(),
      scope: { all: true },
      showOnPages: false,
    });
    expect(hidden.status, hidden.text).toBe(201);
    const body = (await publicPage()).body as PublicStatusPage;
    expect(body.maintenance).toHaveLength(1);
    expect(body.maintenance[0]).toMatchObject({
      name: "Database upgrade",
      active: false,
      components: ["Public API"],
    });
    expect(body.maintenance[0]?.startsAt).toBe(window.body.startsAt);
  });

  it("serves RSS and Atom feeds of the updates", async () => {
    const rss = await request(ctx.app).get(`/api/public/status/${slug}/rss`);
    expect(rss.status).toBe(200);
    expect(rss.headers["content-type"]).toMatch(/application\/rss\+xml/);
    expect(rss.text).toContain("<title>Resolved: Slow page loads</title>");
    expect(rss.text).toContain("Page loads are back to normal.");
    expect(rss.text.match(/<item>/g)).toHaveLength(3);

    const atom = await request(ctx.app).get(`/api/public/status/${slug}/atom`);
    expect(atom.status).toBe(200);
    expect(atom.headers["content-type"]).toMatch(/application\/atom\+xml/);
    expect(atom.text).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(atom.text.match(/<entry>/g)).toHaveLength(3);
  });
});

describe("changes to the page", () => {
  it("a new address moves the page; the old one answers 404 and both are refreshed", async () => {
    const mark = refreshed.length;
    const moved = `acme-new-${run}`;
    const res = await as(owner).patch(`/status-pages/${page.id}`, {
      slug: moved,
      settings: { showUptime: false },
    });
    expect(res.status, res.text).toBe(200);
    expect(res.body.slug).toBe(moved);
    expect(tagsSince(mark)).toEqual(
      expect.arrayContaining([`status-page:${slug}`, `status-page:${moved}`]),
    );
    expect((await publicPage()).status).toBe(404);
    const body = (await publicPage(moved)).body as PublicStatusPage;
    expect(body.page.showUptime).toBe(false);
    expect(body.components.every((c) => c.uptime === null)).toBe(true);
    await as(owner).patch(`/status-pages/${page.id}`, { slug, settings: { showUptime: true } });
  });

  it("an unpublished page is hidden from the public but not from the team", async () => {
    await as(owner).patch(`/status-pages/${page.id}`, { published: false });
    expect((await publicPage()).status).toBe(404);
    expect((await request(ctx.app).get(`/api/public/status/${slug}/rss`)).status).toBe(404);
    expect((await as(owner).get(`/status-pages/${page.id}/preview`)).status).toBe(200);
    await as(owner).patch(`/status-pages/${page.id}`, { published: true });
    expect((await publicPage()).status).toBe(200);
  });

  it("a deleted monitor leaves its component, set by hand from then on", async () => {
    const statuspages = find<StatuspagesModule>("statuspages");
    expect((await as(owner).delete(`/monitors/${webMonitor}`)).status).toBe(204);
    expect(await statuspages.service.onMonitorDeleted(webMonitor)).toBe(1);
    const body = (await publicPage()).body as PublicStatusPage;
    expect(body.components[0]).toMatchObject({
      name: "Website",
      status: "operational",
      uptime: null,
    });
  });

  it("the plan's page limit is enforced, and deleting the page frees its address", async () => {
    const limit = await as(owner).post("/status-pages", { name: "Second", slug: `two-${run}` });
    /* A new workspace is on its Pro trial: ten pages. Fill it up to the limit. */
    expect(limit.status, limit.text).toBe(201);
    for (let i = 3; i <= 10; i += 1) {
      const more = await as(owner).post("/status-pages", {
        name: `Page ${i}`,
        slug: `p${i}-${run}`,
      });
      expect(more.status, more.text).toBe(201);
    }
    const over = await as(owner).post("/status-pages", { name: "Eleven", slug: `p11-${run}` });
    expect(over.status).toBe(402);
    expect(over.body.detail).toMatch(/10 status pages/);

    expect((await as(owner).delete(`/status-pages/${page.id}`)).status).toBe(204);
    expect((await publicPage()).status).toBe(404);
    const again = await as(owner).post("/status-pages", { name: "Acme again", slug });
    expect(again.status, again.text).toBe(201);
  }, 60_000);

  it("public lookups refuse odd references", async () => {
    expect((await publicPage("no-such-page")).status).toBe(404);
    expect((await publicPage("not.verified.example.com")).status).toBe(404);
    expect((await publicPage("a b")).status).toBe(400);
  });
});
