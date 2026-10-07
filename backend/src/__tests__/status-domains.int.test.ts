/*
 * P2-T08 through the real API with DNS answered by the test: a status page on the customer's own
 * domain. The domain serves nothing and gets no certificate until its DNS is seen pointing at us;
 * a verified domain that points elsewhere for a week stops being served.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import type { PublicStatusPage, StatusPageView } from "@app/shared";
import { createFakeClock } from "../core/clock.js";
import type { DnsLookup } from "../infra/dns.js";
import type { StatuspagesModule } from "../modules/statuspages/index.js";
import { WEB_ORIGIN, buildContainerApp, signUpVerified } from "./helpers/container-app.js";

const TARGET = "pages.watchpost.test";
const run = randomBytes(4).toString("hex");
const domain = `status.acme-${run}.io`;
const slug = `dom-${run}`;

/* What the fake DNS answers; tests change it. */
const records: { cname: Record<string, string[]>; a: Record<string, string[]>; down: boolean } = {
  cname: {},
  a: { [TARGET]: ["203.0.113.7"] },
  down: false,
};
const dns: DnsLookup = {
  async cname(host) {
    if (records.down) throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
    return records.cname[host] ?? [];
  },
  async a(host) {
    if (records.down) throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
    return records.a[host] ?? [];
  },
};

const clock = createFakeClock(new Date());
const refreshed: string[][] = [];
const ctx = buildContainerApp({
  authRateLimit: false,
  clock,
  dns,
  revalidate: async (tags) => {
    refreshed.push(tags);
  },
  env: { STATUS_BASE_DOMAIN: "status.watchpost.test", CUSTOM_DOMAIN_CNAME_TARGET: TARGET },
});

let owner: TestAgent;
let ws = "";
let page: StatusPageView;

const api = (method: "get" | "post" | "put" | "patch", path: string) =>
  owner[method](`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN);
const ask = (host: string) => request(ctx.app).get("/api/internal/tls/ask").query({ domain: host });
const statuspages = () =>
  (ctx.container.modules.find((m) => m.name === "statuspages") as StatuspagesModule).service;
const DAY = 86_400_000;

beforeAll(async () => {
  owner = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `dom-${run}@example.com`);
  const created = await owner
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "Domains Co", slug: `dom-ws-${run}` });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id as string;
  const res = await api("post", "/status-pages").send({ name: "Acme", slug });
  expect(res.status, res.text).toBe(201);
  page = res.body as StatusPageView;
}, 120_000);

afterAll(async () => {
  await ctx.container.close();
});

describe("a custom domain", () => {
  it("is served on the status subdomain first, and says what to point a domain at", () => {
    expect(page.url).toBe(`https://${slug}.status.watchpost.test`);
    expect(page).toMatchObject({ customDomain: null, cnameTarget: TARGET });
  });

  it("refuses our own hosts, bad names and paths", async () => {
    for (const bad of [
      "status.watchpost.test",
      `x.status.watchpost.test`,
      TARGET,
      "watchpost.test",
      "localhost",
      "https://status.acme.io",
      "status.acme.io/path",
      "acme",
      "203.0.113.7",
    ]) {
      const res = await api("put", `/status-pages/${page.id}/domain`).send({ domain: bad });
      expect(res.status, bad).toBe(400);
    }
  });

  it("starts unverified: no page on it and no certificate for it", async () => {
    const res = await api("put", `/status-pages/${page.id}/domain`).send({
      domain: domain.toUpperCase(),
    });
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({
      customDomain: domain,
      domainVerifiedAt: null,
      url: `https://${slug}.status.watchpost.test`,
    });
    expect((await ask(domain)).status).toBe(404);
    expect((await request(ctx.app).get(`/api/public/status/${domain}`)).status).toBe(404);

    /* Checking with no DNS record explains what to add and changes nothing. */
    const checked = await api("post", `/status-pages/${page.id}/domain/verify`).send({});
    expect(checked.status, checked.text).toBe(200);
    expect(checked.body.domainVerifiedAt).toBeNull();
    expect(checked.body.domainError).toMatch(
      /Add a CNAME record that points to pages\.watchpost\.test/,
    );
    expect(checked.body.domainCheckedAt).not.toBeNull();
    expect((await ask(domain)).status).toBe(404);
  });

  it("a record that points somewhere else doesn't verify it", async () => {
    records.cname[domain] = ["acme.statuspage.example"];
    const checked = await api("post", `/status-pages/${page.id}/domain/verify`).send({});
    expect(checked.body.domainVerifiedAt).toBeNull();
    expect(checked.body.domainError).toMatch(/points to acme\.statuspage\.example/);
    expect((await ask(domain)).status).toBe(404);
  });

  it("a DNS outage concludes nothing, and a manual check says so", async () => {
    records.down = true;
    const before = (await api("get", `/status-pages/${page.id}`)).body as StatusPageView;
    const checked = await api("post", `/status-pages/${page.id}/domain/verify`).send({});
    expect(checked.status).toBe(502);
    expect(checked.body.detail).toMatch(/DNS couldn't be checked just now/);
    clock.advance(6 * 60_000);
    await statuspages().checkDomains();
    const after = (await api("get", `/status-pages/${page.id}`)).body as StatusPageView;
    expect(after).toMatchObject({
      domainVerifiedAt: null,
      domainError: before.domainError,
      domainCheckedAt: before.domainCheckedAt,
    });
    records.down = false;
  });

  it("verifies once the CNAME points at us; then the page and a certificate are served", async () => {
    records.cname[domain] = [TARGET];
    const mark = refreshed.length;
    /* The sweep finds it without anyone pressing a button. */
    clock.advance(6 * 60_000);
    expect(await statuspages().checkDomains()).toBeGreaterThanOrEqual(1);
    const view = (await api("get", `/status-pages/${page.id}`)).body as StatusPageView;
    expect(view.domainVerifiedAt).not.toBeNull();
    expect(view).toMatchObject({ domainError: null, url: `https://${domain}` });
    expect(refreshed.slice(mark).flat()).toEqual(
      expect.arrayContaining([`status-page:${slug}`, `status-page:${domain}`]),
    );

    expect((await ask(domain)).status).toBe(200);
    expect((await ask(domain.toUpperCase())).status).toBe(200);
    const served = await request(ctx.app).get(`/api/public/status/${domain}`);
    expect(served.status).toBe(200);
    expect((served.body as PublicStatusPage).page).toMatchObject({
      slug,
      url: `https://${domain}`,
    });
    /* The subdomain keeps working too. */
    expect((await request(ctx.app).get(`/api/public/status/${slug}`)).status).toBe(200);
  });

  it("the ask endpoint answers only direct callers and only for known domains", async () => {
    expect((await ask("unknown.example.net")).status).toBe(404);
    expect((await ask(`${slug}.status.watchpost.test`)).status).toBe(404);
    expect((await request(ctx.app).get("/api/internal/tls/ask")).status).toBe(400);
    /* A request that came through a proxy is the public internet: refused. */
    const proxied = await ask(domain).set("X-Forwarded-For", "198.51.100.9");
    expect(proxied.status).toBe(404);
  });

  it("an unpublished page gets no certificate", async () => {
    await api("patch", `/status-pages/${page.id}`).send({ published: false });
    expect((await ask(domain)).status).toBe(404);
    await api("patch", `/status-pages/${page.id}`).send({ published: true });
    expect((await ask(domain)).status).toBe(200);
  });

  it("another page can't take the same domain", async () => {
    const other = await api("post", "/status-pages").send({ name: "Other", slug: `dom2-${run}` });
    expect(other.status, other.text).toBe(201);
    const taken = await api("put", `/status-pages/${other.body.id}/domain`).send({ domain });
    expect(taken.status).toBe(409);
    expect(taken.body.detail).toMatch(/already uses that domain/);
  });

  it("a verified domain survives a short DNS mistake, but not a week of pointing elsewhere", async () => {
    records.cname[domain] = ["somewhere.else.example"];
    clock.advance(DAY + 60_000);
    await statuspages().checkDomains();
    let view = (await api("get", `/status-pages/${page.id}`)).body as StatusPageView;
    expect(view.domainVerifiedAt).not.toBeNull();
    expect(view.domainError).toMatch(/points to somewhere\.else\.example/);
    expect((await ask(domain)).status).toBe(200);

    /* Fixed in time: the warning goes away and the clock starts over. */
    records.cname[domain] = [TARGET];
    clock.advance(DAY + 60_000);
    await statuspages().checkDomains();
    view = (await api("get", `/status-pages/${page.id}`)).body as StatusPageView;
    expect(view).toMatchObject({ domainError: null });
    const [row] = (
      await ctx.container.infra.db.execute<{ failing: string | null }>(
        sql`select domain_failing_since as failing from status_pages where id = ${page.id}`,
      )
    ).rows;
    expect(row?.failing).toBeNull();

    /* Gone for good: eight daily checks later it is no longer served. */
    records.cname[domain] = ["somewhere.else.example"];
    for (let day = 0; day < 8; day += 1) {
      clock.advance(DAY + 60_000);
      await statuspages().checkDomains();
    }
    view = (await api("get", `/status-pages/${page.id}`)).body as StatusPageView;
    expect(view.domainVerifiedAt).toBeNull();
    expect(view.url).toBe(`https://${slug}.status.watchpost.test`);
    expect((await ask(domain)).status).toBe(404);
    expect((await request(ctx.app).get(`/api/public/status/${domain}`)).status).toBe(404);
  });

  it("removing the domain, or changing it, starts over", async () => {
    records.cname[domain] = [TARGET];
    await api("post", `/status-pages/${page.id}/domain/verify`).send({});
    expect((await ask(domain)).status).toBe(200);
    const next = `status2.acme-${run}.io`;
    const changed = await api("put", `/status-pages/${page.id}/domain`).send({ domain: next });
    expect(changed.body).toMatchObject({ customDomain: next, domainVerifiedAt: null });
    expect((await ask(domain)).status).toBe(404);
    expect((await ask(next)).status).toBe(404);

    const removed = await api("put", `/status-pages/${page.id}/domain`).send({ domain: null });
    expect(removed.body).toMatchObject({ customDomain: null, domainVerifiedAt: null });
    const nothing = await api("post", `/status-pages/${page.id}/domain/verify`).send({});
    expect(nothing.status).toBe(409);
  });

  it("a plan without custom domains is told to upgrade", async () => {
    /* The trial ends: the workspace is on Free, which has no custom domains. */
    clock.advance(30 * DAY);
    const res = await api("put", `/status-pages/${page.id}/domain`).send({ domain });
    expect(res.status, res.text).toBe(402);
    expect(res.body.detail).toMatch(/Starter plan/);
  });
});
