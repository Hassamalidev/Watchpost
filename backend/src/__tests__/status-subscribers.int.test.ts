/*
 * P2-T09 through the real API: visitors subscribe to a status page by email (double opt-in), hear
 * about an incident when it is created, updated and resolved, and leave with one click. And a page
 * opens an incident by itself when a monitor stays down, and closes it when the monitor is back.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { v7 as uuidv7 } from "uuid";
import type {
  PublicStatusPage,
  StatusIncidentView,
  StatusPageView,
  StatusSubscribersView,
} from "@app/shared";
import type { DetectionModule } from "../modules/detection/index.js";
import type { ProbesModule } from "../modules/probes/index.js";
import type { ResultsModule } from "../modules/results/index.js";
import type { StatuspagesModule } from "../modules/statuspages/index.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  probeClient,
  signUpVerified,
} from "./helpers/container-app.js";

const ctx = buildContainerApp({ authRateLimit: false, revalidate: async () => undefined });
const run = randomBytes(4).toString("hex");
const slug = `subs-${run}`;
const ada = `ada-${run}@example.org`;
const bob = `bob-${run}@example.org`;
let owner: TestAgent;
let ws = "";
let page: StatusPageView;
let monitorId = "";
const handled = new Set<string>();

const api = (method: "get" | "post" | "patch" | "put" | "delete", path: string) =>
  owner[method](`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN);
const find = <T>(name: string) => ctx.container.modules.find((m) => m.name === name) as T;
const statuspages = () => find<StatuspagesModule>("statuspages").service;
const publicPage = async () =>
  (await request(ctx.app).get(`/api/public/status/${slug}`)).body as PublicStatusPage;

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await ctx.container.infra.db.execute(query)).rows as T[];
}

interface Email {
  template: string;
  to: string;
  data: Record<string, string>;
  headers?: Record<string, string>;
  idempotencyKey?: string;
}

/* Emails queued for an address, oldest first. */
const emailsTo = async (to: string, template: string): Promise<Email[]> =>
  (
    await rows<{ payload: Email }>(sql`
      select payload from outbox_events
      where type = 'email.requested' and payload->>'to' = ${to}
        and payload->>'template' = ${template}
      order by created_at, id`)
  ).map((r) => r.payload);

const tokenOf = (url: string | undefined) => new URL(url ?? "").searchParams.get("token") ?? "";

/* What the worker does with new `status_page.update_published` events: email the subscribers. */
async function fanOut(): Promise<number> {
  const events = await rows<{ id: string; payload: { updateId: string } }>(sql`
    select id, payload from outbox_events
    where workspace_id = ${ws} and type = 'status_page.update_published' order by created_at, id`);
  let sent = 0;
  for (const e of events) {
    if (handled.has(e.id)) continue;
    handled.add(e.id);
    sent += await statuspages().notifySubscribers(e.payload.updateId);
  }
  return sent;
}

async function subscribe(email: string) {
  return request(ctx.app).post(`/api/public/status/${slug}/subscribers`).send({ email });
}

let tick = 1_000;
async function settle(ok: boolean) {
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
  await signUpVerified(ctx, owner, `subs-${run}@example.com`);
  const created = await owner
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "Subscribers Co", slug: `subs-ws-${run}` });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id as string;

  const creds = await find<ProbesModule>("probes").service.register({
    name: `subs-${run}`,
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

  const monitor = await api("post", "/monitors").send({
    settings: { name: "Payments", regions: ["eu-central"], minFailingRegions: 1 },
    config: { type: "tcp", host: "example.com", port: 443 },
  });
  expect(monitor.status, monitor.text).toBe(201);
  monitorId = monitor.body.id as string;

  const res = await api("post", "/status-pages").send({
    name: "Acme",
    slug,
    monitorIds: [monitorId],
  });
  expect(res.status, res.text).toBe(201);
  page = res.body as StatusPageView;
}, 120_000);

afterAll(async () => {
  await ctx.container.infra.db.execute(sql`delete from probe_tasks where workspace_id = ${ws}`);
  await ctx.container.close();
});

describe("subscribing", () => {
  it("the page says it takes subscribers", async () => {
    expect((await publicPage()).page.subscribe).toBe(true);
  });

  it("asks the visitor to confirm, and nobody is subscribed until they do", async () => {
    const res = await subscribe(` ${ada.toUpperCase()} `);
    expect(res.status, res.text).toBe(202);
    const [mail] = await emailsTo(ada, "status-confirm");
    expect(mail?.data).toMatchObject({ pageName: "Acme", pageUrl: `${WEB_ORIGIN}/s/${slug}` });
    expect(mail?.data.url).toContain(
      `${WEB_ORIGIN}/api/public/status-subscriptions/confirm?token=`,
    );

    const list = (await api("get", `/status-pages/${page.id}/subscribers`))
      .body as StatusSubscribersView;
    expect(list).toMatchObject({ confirmed: 0, pending: 1, limit: 2_000 });
    expect(list.data[0]).toMatchObject({ email: ada, confirmedAt: null });

    /* An incident now reaches nobody. */
    const incident = await api("post", `/status-pages/${page.id}/incidents`).send({
      title: "Before anyone confirmed",
      message: "Nobody hears this.",
      status: "resolved",
    });
    expect(incident.status, incident.text).toBe(201);
    expect(await fanOut()).toBe(0);
    expect(await emailsTo(ada, "status-update")).toEqual([]);
  });

  it("asking again right away sends no second email and says nothing new", async () => {
    expect((await subscribe(ada)).status).toBe(202);
    expect(await emailsTo(ada, "status-confirm")).toHaveLength(1);
    /* After a while a new link is sent, and the old one stops working. */
    await ctx.container.infra.db.execute(sql`
      update status_subscribers set confirm_sent_at = now() - interval '10 minutes'
      where page_id = ${page.id} and email = ${ada}`);
    expect((await subscribe(ada)).status).toBe(202);
    const mails = await emailsTo(ada, "status-confirm");
    expect(mails).toHaveLength(2);
    const stale = await request(ctx.app)
      .get("/api/public/status-subscriptions/confirm")
      .query({ token: tokenOf(mails[0]?.data.url) });
    expect(stale.status).toBe(404);
    expect(stale.text).toContain("no longer valid");
  });

  it("the link in the email confirms once and sends the visitor back to the page", async () => {
    const mails = await emailsTo(ada, "status-confirm");
    const token = tokenOf(mails.at(-1)?.data.url);
    const confirmed = await request(ctx.app)
      .get("/api/public/status-subscriptions/confirm")
      .query({ token });
    expect(confirmed.status).toBe(303);
    expect(confirmed.headers.location).toBe(`${WEB_ORIGIN}/s/${slug}?subscribe=confirmed`);
    const again = await request(ctx.app)
      .get("/api/public/status-subscriptions/confirm")
      .query({ token });
    expect(again.status).toBe(404);

    const list = (await api("get", `/status-pages/${page.id}/subscribers`))
      .body as StatusSubscribersView;
    expect(list).toMatchObject({ confirmed: 1, pending: 0 });
    /* Already subscribed: the same answer, and no email. */
    expect((await subscribe(ada)).status).toBe(202);
    expect(await emailsTo(ada, "status-confirm")).toHaveLength(2);
  });

  it("the page's own form works without JavaScript", async () => {
    const res = await request(ctx.app)
      .post(`/api/public/status/${slug}/subscribers`)
      .type("form")
      .send({ email: bob });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`${WEB_ORIGIN}/s/${slug}?subscribe=sent`);
    /* The redirect goes back to the page the form was on, never to an address that isn't the page's. */
    const elsewhere = await request(ctx.app)
      .post(`/api/public/status/${slug}/subscribers`)
      .set("Referer", "https://evil.example.net/phish?x=1")
      .type("form")
      .send({ email: bob });
    expect(elsewhere.headers.location).toBe(`${WEB_ORIGIN}/s/${slug}?subscribe=sent`);
    const [mail] = await emailsTo(bob, "status-confirm");
    await request(ctx.app)
      .get("/api/public/status-subscriptions/confirm")
      .query({ token: tokenOf(mail?.data.url) });
    const bad = await request(ctx.app)
      .post(`/api/public/status/${slug}/subscribers`)
      .send({ email: "not-an-email" });
    expect(bad.status).toBe(400);
    const nowhere = await request(ctx.app)
      .post("/api/public/status/no-such-page/subscribers")
      .send({ email: ada });
    expect(nowhere.status).toBe(404);
  });
});

describe("updates by email", () => {
  let incident: StatusIncidentView;

  it("subscribers receive create, update and resolve", async () => {
    const created = await api("post", `/status-pages/${page.id}/incidents`).send({
      title: "Card payments are failing",
      message: "We are investigating failed card payments.",
      impact: "major_outage",
      componentIds: [page.components[0]?.id],
    });
    expect(created.status, created.text).toBe(201);
    incident = created.body as StatusIncidentView;
    expect(await fanOut()).toBe(2);

    await api("post", `/status-pages/${page.id}/incidents/${incident.id}/updates`).send({
      status: "identified",
      message: "A provider is having trouble.",
    });
    expect(await fanOut()).toBe(2);

    await api("post", `/status-pages/${page.id}/incidents/${incident.id}/updates`).send({
      status: "resolved",
      message: "Payments work again.",
    });
    expect(await fanOut()).toBe(2);

    const mails = await emailsTo(ada, "status-update");
    expect(mails.map((m) => [m.data.status, m.data.message])).toEqual([
      ["investigating", "We are investigating failed card payments."],
      ["identified", "A provider is having trouble."],
      ["resolved", "Payments work again."],
    ]);
    expect(mails[0]?.data).toMatchObject({
      pageName: "Acme",
      title: "Card payments are failing",
      components: ["Payments"],
      pageUrl: `${WEB_ORIGIN}/s/${slug}`,
    });
    /* Mail apps can unsubscribe with their own button (RFC 8058). */
    const unsubscribeUrl = mails[0]?.data.unsubscribeUrl ?? "";
    expect(mails[0]?.headers).toEqual({
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(await emailsTo(bob, "status-update")).toHaveLength(3);
  });

  it("running the fan-out again sends nothing twice", async () => {
    handled.clear();
    expect(await fanOut()).toBe(0);
    expect(await emailsTo(ada, "status-update")).toHaveLength(3);
  });

  it("a draft reaches nobody until it is published", async () => {
    const draft = await api("post", `/status-pages/${page.id}/incidents`).send({
      title: "Planned failover",
      message: "We will switch data centres tonight.",
      published: false,
    });
    expect(await fanOut()).toBe(0);
    await api("patch", `/status-pages/${page.id}/incidents/${draft.body.id}`).send({
      published: true,
    });
    expect(await fanOut()).toBe(2);
    expect((await emailsTo(ada, "status-update")).at(-1)?.data.title).toBe("Planned failover");
    await api("post", `/status-pages/${page.id}/incidents/${draft.body.id}/updates`).send({
      status: "resolved",
      message: "Done.",
    });
    await fanOut();
  });

  it("one-click unsubscribe works, and the next update skips that address", async () => {
    const [mail] = await emailsTo(ada, "status-update");
    const token = tokenOf(mail?.data.unsubscribeUrl);
    const oneClick = await request(ctx.app)
      .post("/api/public/status-subscriptions/unsubscribe")
      .query({ token })
      .type("form")
      .send({ "List-Unsubscribe": "One-Click" });
    expect(oneClick.status).toBe(200);

    const before = (await emailsTo(ada, "status-update")).length;
    await api("post", `/status-pages/${page.id}/incidents`).send({
      title: "After Ada left",
      message: "Only Bob hears this.",
      status: "resolved",
    });
    expect(await fanOut()).toBe(1);
    expect(await emailsTo(ada, "status-update")).toHaveLength(before);
    expect((await emailsTo(bob, "status-update")).at(-1)?.data.title).toBe("After Ada left");

    /* The link in the email does the same for a person, and using it twice is not an error. */
    const [bobMail] = await emailsTo(bob, "status-update");
    const link = await request(ctx.app)
      .get("/api/public/status-subscriptions/unsubscribe")
      .query({ token: tokenOf(bobMail?.data.unsubscribeUrl) });
    expect(link.status).toBe(303);
    expect(link.headers.location).toBe(`${WEB_ORIGIN}/s/${slug}?subscribe=removed`);
    const twice = await request(ctx.app)
      .get("/api/public/status-subscriptions/unsubscribe")
      .query({ token: tokenOf(bobMail?.data.unsubscribeUrl) });
    expect(twice.status).toBe(200);
    expect(twice.text).toContain("You are unsubscribed");
    const list = (await api("get", `/status-pages/${page.id}/subscribers`))
      .body as StatusSubscribersView;
    expect(list).toMatchObject({ confirmed: 0, pending: 0 });
  });

  it("the team can remove a subscriber, and switch subscribing off", async () => {
    await subscribe(ada);
    const list = (await api("get", `/status-pages/${page.id}/subscribers`))
      .body as StatusSubscribersView;
    const id = list.data.find((s) => s.email === ada)?.id ?? "";
    expect((await api("delete", `/status-pages/${page.id}/subscribers/${id}`)).status).toBe(204);
    expect((await api("delete", `/status-pages/${page.id}/subscribers/${id}`)).status).toBe(404);

    await api("patch", `/status-pages/${page.id}`).send({
      settings: { ...page.settings, subscribers: false },
    });
    expect((await publicPage()).page.subscribe).toBe(false);
    expect((await subscribe(ada)).status).toBe(404);
    await api("patch", `/status-pages/${page.id}`).send({ settings: page.settings });
  });
});

describe("automatic incidents", () => {
  const auto = async () =>
    (
      (await api("get", `/status-pages/${page.id}/incidents`)).body.data as StatusIncidentView[]
    ).filter((i) => i.auto);

  it("stays quiet while the page hasn't asked for them", async () => {
    await settle(false);
    await ctx.container.infra.db.execute(sql`
      update monitor_state set since = now() - interval '30 minutes' where monitor_id = ${monitorId}`);
    expect(await statuspages().autoIncidents()).toMatchObject({ opened: 0 });
    expect(await auto()).toEqual([]);
  }, 60_000);

  it("opens one once the monitor has been down as long as the page allows", async () => {
    await subscribe(bob);
    const [mail] = (await emailsTo(bob, "status-confirm")).slice(-1);
    await request(ctx.app)
      .get("/api/public/status-subscriptions/confirm")
      .query({ token: tokenOf(mail?.data.url) });

    await api("patch", `/status-pages/${page.id}`).send({
      settings: {
        ...page.settings,
        autoIncidents: { enabled: true, afterMinutes: 5, publish: "auto" },
      },
    });
    /* Down for two minutes: not yet. */
    await ctx.container.infra.db.execute(sql`
      update monitor_state set since = now() - interval '2 minutes' where monitor_id = ${monitorId}`);
    expect(await statuspages().autoIncidents()).toEqual({ opened: 0, resolved: 0 });

    await ctx.container.infra.db.execute(sql`
      update monitor_state set since = now() - interval '6 minutes' where monitor_id = ${monitorId}`);
    expect(await statuspages().autoIncidents()).toEqual({ opened: 1, resolved: 0 });
    /* The next sweep finds it open and does nothing. */
    expect(await statuspages().autoIncidents()).toEqual({ opened: 0, resolved: 0 });

    const [incident] = await auto();
    expect(incident).toMatchObject({
      title: "Payments is unavailable",
      status: "investigating",
      impact: "major_outage",
      published: true,
      componentIds: [page.components[0]?.id],
    });
    const seen = await publicPage();
    expect(seen.incidents.active.map((i) => i.title)).toContain("Payments is unavailable");
    expect(await fanOut()).toBe(1);
    expect((await emailsTo(bob, "status-update")).at(-1)?.data).toMatchObject({
      title: "Payments is unavailable",
      status: "investigating",
    });
  }, 60_000);

  it("resolves it as soon as the monitor is back", async () => {
    await settle(true);
    /* What the worker does with the state change. */
    expect(await statuspages().onMonitorChanged(monitorId)).toBe(1);
    const [incident] = await auto();
    expect(incident).toMatchObject({ status: "resolved" });
    expect(incident?.resolvedAt).not.toBeNull();
    expect(incident?.updates[0]?.message).toBe("Payments is responding normally again.");
    expect(await fanOut()).toBe(1);
    expect((await publicPage()).incidents.active).toEqual([]);
  }, 60_000);

  it("can hold the incident as a draft for a person to publish", async () => {
    await api("patch", `/status-pages/${page.id}`).send({
      settings: {
        ...page.settings,
        autoIncidents: { enabled: true, afterMinutes: 1, publish: "draft" },
      },
    });
    await settle(false);
    await ctx.container.infra.db.execute(sql`
      update monitor_state set since = now() - interval '3 minutes' where monitor_id = ${monitorId}`);
    expect(await statuspages().autoIncidents()).toEqual({ opened: 1, resolved: 0 });
    const draft = (await auto()).find((i) => i.resolvedAt === null);
    expect(draft).toMatchObject({ published: false });
    expect((await publicPage()).incidents.active).toEqual([]);
    expect(await fanOut()).toBe(0);
    /* Back up before anyone published it: closed without a word to the public. */
    await settle(true);
    await statuspages().onMonitorChanged(monitorId);
    expect((await auto()).every((i) => i.resolvedAt !== null)).toBe(true);
    expect(await fanOut()).toBe(0);
  }, 60_000);
});
