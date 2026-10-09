/*
 * P7-T04a through the real API: a status page on Business can be limited to people who know its
 * password or who come from listed networks. Everyone else gets the page's name and nothing more,
 * from the page, its feeds, its subscribe form and its widget.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import type { PublicStatusLocked, PublicStatusPage, StatusPageView } from "@app/shared";
import { newId } from "../infra/ids.js";
import { WEB_ORIGIN, buildContainerApp, signUpVerified } from "./helpers/container-app.js";

const WEB_SECRET = "private-pages-web-secret";
const ctx = buildContainerApp({
  authRateLimit: false,
  revalidate: async () => undefined,
  env: { REVALIDATE_SECRET: WEB_SECRET },
});
const run = randomBytes(4).toString("hex");
const slug = `private-${run}`;
const pageUrl = `${WEB_ORIGIN}/s/${slug}`;
let owner: TestAgent;
let ws = "";
let page: StatusPageView;

const api = (method: "get" | "post" | "put", path: string) =>
  owner[method](`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN);
const open = (agent: TestAgent | ReturnType<typeof request> = request(ctx.app), path = "") =>
  agent.get(`/api/public/status/${slug}${path}`);
/* The web app asking for a visitor it names. */
const asWebApp = (ip: string, secret = WEB_SECRET) =>
  open().set("x-status-web-secret", secret).set("x-status-visitor-ip", ip);

beforeAll(async () => {
  owner = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `private-${run}@example.com`);
  const created = await owner
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "Private Co", slug: `private-ws-${run}` });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id as string;
  const made = await api("post", "/status-pages").send({ name: "Private Co status", slug });
  expect(made.status, made.text).toBe(201);
  page = made.body as StatusPageView;
}, 120_000);

afterAll(async () => {
  await ctx.container.close();
});

describe("private status pages", () => {
  it("start public, and limiting them is part of Business", async () => {
    expect(page).toMatchObject({ visibility: "public", hasPassword: false, allowedIps: [] });
    const anyone = await open();
    expect(anyone.status).toBe(200);
    expect(anyone.headers["cache-control"]).toBe("public, max-age=5");

    const onTrial = await api("put", `/status-pages/${page.id}/access`).send({
      visibility: "password",
      password: "open sesame 1",
    });
    expect(onTrial.status).toBe(402);
    expect(onTrial.body.detail).toContain("Business plan");

    const start = new Date(Date.now() - 86_400_000).toISOString();
    const end = new Date(Date.now() + 29 * 86_400_000).toISOString();
    await ctx.container.infra.db.execute(sql`
      insert into subscriptions (id, workspace_id, paddle_subscription_id, paddle_customer_id, status,
        plan_key, billing_interval, items, period_start, period_end, paid_period_start, paid_period_end,
        last_event_at)
      values (${newId()}, ${ws}, ${`sub_${run}`}, ${`ctm_${run}`}, 'active', 'business', 'month',
        '[]'::jsonb, ${start}::timestamptz, ${end}::timestamptz, ${start}::timestamptz, ${end}::timestamptz,
        ${start}::timestamptz)`);
  });

  it("asks for a password, and never sends it back", async () => {
    const without = await api("put", `/status-pages/${page.id}/access`).send({
      visibility: "password",
    });
    expect(without.status).toBe(400);
    expect(without.body.detail).toContain("Choose a password");

    const set = await api("put", `/status-pages/${page.id}/access`).send({
      visibility: "password",
      password: "open sesame 1",
    });
    expect(set.status, set.text).toBe(200);
    expect(set.body).toMatchObject({ visibility: "password", hasPassword: true });
    expect(set.text).not.toContain("open sesame");
    expect(set.text).not.toContain("scrypt");
    expect((await api("get", `/status-pages/${page.id}`)).text).not.toContain("scrypt");
  });

  it("shows a visitor without the password the page's name and nothing else", async () => {
    const locked = await open();
    expect(locked.status).toBe(401);
    expect(locked.headers["cache-control"]).toBe("private, no-store");
    expect(locked.body as PublicStatusLocked).toEqual({
      locked: "password",
      page: { name: "Private Co status", slug, url: pageUrl, branding: expect.any(Object) },
    });
    expect((await open(undefined, "/rss")).status).toBe(404);
    expect((await open(undefined, "/atom")).status).toBe(404);
    const subscribe = await request(ctx.app)
      .post(`/api/public/status/${slug}/subscribers`)
      .send({ email: `visitor-${run}@example.org` });
    expect(subscribe.status).toBe(404);
    expect((await request(ctx.app).get(`/api/public/status-widget/${slug}.svg`)).status).toBe(404);
  });

  it("lets a browser in once the password was entered, and out again when it changes", async () => {
    const visitor = request.agent(ctx.app);
    const wrongJson = await visitor
      .post(`/api/public/status/${slug}/unlock`)
      .send({ password: "open sesame 2" });
    expect(wrongJson.status).toBe(401);
    expect(wrongJson.headers["set-cookie"]).toBeUndefined();
    const wrongForm = await visitor
      .post(`/api/public/status/${slug}/unlock`)
      .type("form")
      .set("Referer", pageUrl)
      .send({ password: "nope" });
    expect(wrongForm.status).toBe(303);
    expect(wrongForm.headers.location).toBe(`${pageUrl}?unlock=wrong`);
    expect((await open(visitor)).status).toBe(401);

    const right = await visitor
      .post(`/api/public/status/${slug}/unlock`)
      .type("form")
      .set("Referer", pageUrl)
      .send({ password: "open sesame 1" });
    expect(right.status).toBe(303);
    expect(right.headers.location).toBe(pageUrl);
    const cookie = String(right.headers["set-cookie"]);
    expect(cookie).toContain(`wp_sp_${page.id.replace(/-/g, "")}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");

    const inside = await open(visitor);
    expect(inside.status).toBe(200);
    expect(inside.headers["cache-control"]).toBe("private, no-store");
    expect((inside.body as PublicStatusPage).page.name).toBe("Private Co status");
    expect((await open(visitor, "/rss")).status).toBe(200);
    /* Someone else is still outside. */
    expect((await open()).status).toBe(401);

    const changed = await api("put", `/status-pages/${page.id}/access`).send({
      visibility: "password",
      password: "a new password",
    });
    expect(changed.status, changed.text).toBe(200);
    expect((await open(visitor)).status).toBe(401);
  });

  it("can be limited to networks instead", async () => {
    const empty = await api("put", `/status-pages/${page.id}/access`).send({
      visibility: "ip_allowlist",
      allowedIps: [],
    });
    expect(empty.status).toBe(400);
    const bad = await api("put", `/status-pages/${page.id}/access`).send({
      visibility: "ip_allowlist",
      allowedIps: ["office.example.com"],
    });
    expect(bad.status).toBe(400);

    const set = await api("put", `/status-pages/${page.id}/access`).send({
      visibility: "ip_allowlist",
      allowedIps: ["203.0.113.0/24", "2001:DB8::/32", "203.0.113.0/24"],
    });
    expect(set.status, set.text).toBe(200);
    expect(set.body).toMatchObject({
      visibility: "ip_allowlist",
      allowedIps: ["203.0.113.0/24", "2001:db8::/32"],
    });

    /* This test's own address is not on the list. */
    const outside = await open();
    expect(outside.status).toBe(401);
    expect(outside.body.locked).toBe("ip_allowlist");
    /* The web app names the visitor; only with the shared secret is it believed. */
    expect((await asWebApp("203.0.113.9")).status).toBe(200);
    expect((await asWebApp("::ffff:203.0.113.9")).status).toBe(200);
    expect((await asWebApp("2001:db8:7::1")).status).toBe(200);
    expect((await asWebApp("198.51.100.1")).status).toBe(401);
    expect((await asWebApp("203.0.113.9", "not-the-secret")).status).toBe(401);
    expect((await open().set("x-status-visitor-ip", "203.0.113.9")).status).toBe(401);
    expect((await open().set("x-status-web-secret", WEB_SECRET)).status).toBe(401);

    /* A visitor who reaches the API directly is judged by their own address. */
    const local = await api("put", `/status-pages/${page.id}/access`).send({
      visibility: "ip_allowlist",
      allowedIps: ["127.0.0.1", "::1"],
    });
    expect(local.status, local.text).toBe(200);
    expect((await open()).status).toBe(200);
  });

  it("is open to everyone again when made public", async () => {
    const set = await api("put", `/status-pages/${page.id}/access`).send({ visibility: "public" });
    expect(set.body).toMatchObject({ visibility: "public", hasPassword: true });
    const anyone = await open();
    expect(anyone.status).toBe(200);
    expect(anyone.headers["cache-control"]).toBe("public, max-age=5");
    expect((await open(undefined, "/rss")).status).toBe(200);
  });
});
