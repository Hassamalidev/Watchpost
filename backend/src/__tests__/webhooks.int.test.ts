/*
 * P6-T02 through the real app with a stand-in for the network: events reach the endpoints that
 * subscribed to them, once, signed, in the public shape or the endpoint's own template; failures are
 * retried on the documented schedule and then given up; people can send a test and replay a
 * delivery; an endpoint that keeps failing or answers 410 is switched off.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import pino from "pino";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import {
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_RETRY_MINUTES,
  type WebhookDeliveryView,
  type WebhookEndpointView,
  type WebhookEndpointWithSecret,
  type WebhookEnvelope,
} from "@app/shared";
import { createFakeClock } from "../core/clock.js";
import { OutboundError, type OutboundRequest } from "../infra/http/outbound.js";
import { signWebhookBody, type WebhooksModule } from "../modules/webhooks/index.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  signUpVerified,
  stubHttp,
} from "./helpers/container-app.js";

const MINUTE = 60_000;
const DAY = 86_400_000;
const clock = createFakeClock(new Date());
/* What each receiving address answers; 200 unless a test says otherwise. */
const answers = new Map<string, number | "unreachable">();
const http = stubHttp((req) => {
  const answer = answers.get(req.url);
  if (answer === "unreachable") throw new OutboundError("network", "connection refused");
  return { status: answer ?? 200 };
});
const ctx = buildContainerApp({ authRateLimit: false, clock, http });
const run = randomBytes(4).toString("hex");
const url = (name: string) => `https://hooks.example.com/${run}/${name}`;
let owner: TestAgent;
let ws = "";

const api = (method: "get" | "post" | "patch" | "delete", path: string) =>
  owner[method](`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN);
const webhooks = () => ctx.container.modules.find((m) => m.name === "webhooks") as WebhooksModule;
const sentTo = (name: string): OutboundRequest[] =>
  http.requests.filter((r) => r.url === url(name));
const bodyOf = (req: OutboundRequest | undefined) =>
  JSON.parse(req?.body ?? "null") as WebhookEnvelope;

async function endpoint(
  name: string,
  events: string[],
  extra: Record<string, unknown> = {},
): Promise<WebhookEndpointWithSecret> {
  const res = await api("post", "/webhooks").send({ name, url: url(name), events, ...extra });
  expect(res.status, res.text).toBe(201);
  return res.body as WebhookEndpointWithSecret;
}

const deliveries = async (id: string) =>
  (await api("get", `/webhooks/${id}/deliveries?limit=100`)).body.data as WebhookDeliveryView[];
const view = async (id: string) =>
  ((await api("get", "/webhooks")).body.data as WebhookEndpointView[]).find((e) => e.id === id);

/*
 * Runs the module's event handler for this workspace's new events, as the worker would. With
 * `again`, the events handled before are handed over once more: a job that runs twice.
 */
const handled = new Set<string>();
async function pump(options: { again?: boolean } = {}): Promise<void> {
  const processor = webhooks().processors?.find((p) => p.queue === "webhooks-events");
  if (processor === undefined) throw new Error("no webhooks-events processor");
  const events = await ctx.container.infra.db.execute<{ id: string; type: string }>(
    sql`select id, type from outbox_events where workspace_id = ${ws} order by created_at, id`,
  );
  for (const event of events.rows) {
    if (!(WEBHOOK_EVENT_TYPES as readonly string[]).includes(event.type)) continue;
    if (handled.has(event.id) !== (options.again === true)) continue;
    handled.add(event.id);
    await processor.run(
      { data: { eventId: event.id, type: event.type, handler: "webhooks" } } as never,
      pino({ level: "silent" }),
    );
  }
}

async function monitor(name: string): Promise<string> {
  const res = await api("post", "/monitors").send({
    settings: { name },
    config: { type: "tcp", host: "example.com", port: 443 },
  });
  expect(res.status, res.text).toBe(201);
  return res.body.id as string;
}

beforeAll(async () => {
  owner = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `hooks-${run}@example.com`);
  const created = await owner
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "Hooks Co", slug: `hooks-${run}` });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id as string;
}, 120_000);

afterAll(async () => {
  await ctx.container.close();
});

describe("webhook endpoints", () => {
  it("lists the events there are, with an example of each", async () => {
    const res = await api("get", "/webhook-events");
    expect(res.status).toBe(200);
    expect(res.body.data.map((e: { type: string }) => e.type)).toEqual([...WEBHOOK_EVENT_TYPES]);
    /* docs/webhooks.md has a row for each. */
    const guide = readFileSync(new URL("../../../docs/webhooks.md", import.meta.url), "utf8");
    for (const type of WEBHOOK_EVENT_TYPES) expect(guide).toContain(`| \`${type}\``);
    expect(res.body.data[0].sample).toMatchObject({
      type: "incident.triggered",
      data: { incident: { number: 42 }, monitor: { name: "Checkout API" } },
    });
  });

  it("shows the signing secret once and never the header values", async () => {
    const created = await endpoint("all", ["*"], { headers: { Authorization: "Bearer s3cret" } });
    expect(created.secret).toMatch(/^whsec_[\w-]{32}$/);
    expect(created).toMatchObject({
      name: "all",
      events: ["*"],
      headerNames: ["Authorization"],
      enabled: true,
      bodyTemplate: null,
    });
    const listed = await api("get", "/webhooks");
    expect(JSON.stringify(listed.body)).not.toContain(created.secret);
    expect(JSON.stringify(listed.body)).not.toContain("s3cret");
    /* Encrypted at rest, too. */
    const stored = await ctx.container.infra.db.execute<{ secret: string; headers: string }>(
      sql`select secret, headers from webhook_endpoints where id = ${created.id}`,
    );
    expect(stored.rows[0]?.secret).not.toContain(created.secret);
    expect(stored.rows[0]?.headers).not.toContain("s3cret");
  });

  it("refuses addresses, events and templates that can't work", async () => {
    const bad = async (body: Record<string, unknown>) =>
      (
        await api("post", "/webhooks").send({
          name: "x",
          url: url("x"),
          events: ["incident.*"],
          ...body,
        })
      ).status;
    expect(await bad({ url: "http://hooks.example.com/plain" })).toBe(400);
    expect(await bad({ events: [] })).toBe(400);
    expect(await bad({ events: ["incident.exploded"] })).toBe(400);
    expect(await bad({ headers: { "Content-Type": "text/plain" } })).toBe(400);
    /* A text placeholder outside quotes doesn't make JSON. */
    const template = await api("post", "/webhooks").send({
      name: "x",
      url: url("x"),
      events: ["incident.*"],
      bodyTemplate: '{"title": {{data.incident.title}}}',
    });
    expect(template.status).toBe(400);
    expect(template.body.errors[0].message).toContain("valid JSON");
  });
});

describe("deliveries", () => {
  let all: WebhookEndpointWithSecret;
  let incidentsOnly: WebhookEndpointWithSecret;
  let monitorId = "";

  beforeAll(async () => {
    all = (
      (await api("get", "/webhooks")).body.data as WebhookEndpointWithSecret[]
    )[0] as WebhookEndpointWithSecret;
    /* The secret isn't listed; take a fresh one to verify signatures with. */
    all = (await api("post", `/webhooks/${all.id}/secret`)).body as WebhookEndpointWithSecret;
    incidentsOnly = await endpoint("incidents", ["incident.*"]);
  });

  it("sends an event once to the endpoints that asked for it, signed", async () => {
    monitorId = await monitor("Checkout API");
    await pump();
    const [req, ...rest] = sentTo("all");
    expect(rest).toEqual([]);
    expect(sentTo("incidents")).toEqual([]);
    const envelope = bodyOf(req);
    expect(envelope).toMatchObject({
      type: "monitor.created",
      workspaceId: ws,
      data: { monitor: { id: monitorId, name: "Checkout API", type: "tcp" } },
    });
    expect(req?.method).toBe("POST");
    expect(req?.headers).toMatchObject({
      "content-type": "application/json",
      Authorization: "Bearer s3cret",
      "watchpost-event-id": envelope.id,
      "watchpost-event-type": "monitor.created",
    });
    /* The signature is over "<timestamp>.<body>" with the endpoint's secret. */
    const signature = req?.headers?.["watchpost-signature"] ?? "";
    const timestamp = Number(/^t=(\d+),v1=[0-9a-f]{64}$/.exec(signature)?.[1]);
    expect(Math.abs(timestamp * 1_000 - clock.now().getTime())).toBeLessThan(2_000);
    expect(signature).toBe(signWebhookBody(all.secret, timestamp, req?.body ?? ""));

    /* Handling the same events again sends nothing again. */
    await pump({ again: true });
    expect(sentTo("all")).toHaveLength(1);
    const [delivery] = await deliveries(all.id);
    expect(delivery).toMatchObject({
      eventType: "monitor.created",
      status: "delivered",
      attempts: 1,
      responseStatus: 200,
      error: null,
      manual: false,
      nextAttemptAt: null,
    });
    expect((await view(all.id))?.lastDeliveryAt).not.toBeNull();
  });

  it("follows an incident from opened to resolved, in the public shape", async () => {
    const opened = await api("post", "/incidents").send({
      title: "Checkout is down",
      severity: "critical",
      monitorId,
    });
    expect(opened.status, opened.text).toBe(201);
    const number = opened.body.number as number;
    await api("post", `/incidents/${number}/acknowledge`).send({});
    await api("post", `/incidents/${number}/resolve`).send({});
    await pump();

    const received = sentTo("incidents").map(bodyOf);
    expect(received.map((e) => e.type)).toEqual([
      "incident.triggered",
      "incident.acknowledged",
      "incident.resolved",
    ]);
    /* Each event has its own ID; the data is the incident as it is when the event is handled. */
    expect(new Set(received.map((e) => e.id)).size).toBe(3);
    expect(received[2]?.data).toMatchObject({
      incident: {
        id: opened.body.id,
        number,
        title: "Checkout is down",
        severity: "critical",
        status: "resolved",
        url: `${WEB_ORIGIN}/w/${ws}/incidents/${number}`,
      },
      monitor: { id: monitorId, name: "Checkout API", type: "tcp" },
    });
    /* Nothing internal travels along. */
    const incident = received[0]?.data.incident as Record<string, unknown>;
    expect(Object.keys(incident)).not.toContain("evidence");
    expect(Object.keys(incident)).not.toContain("aiSummary");
    /* The endpoint that wants everything got them too, after its monitor event. */
    expect(sentTo("all").map((r) => bodyOf(r).type)).toEqual([
      "monitor.created",
      "incident.triggered",
      "incident.acknowledged",
      "incident.resolved",
    ]);
  });

  it("fills the endpoint's own template instead of the standard body", async () => {
    const templated = await endpoint("templated", ["incident.triggered"], {
      bodyTemplate:
        '{"text":"#{{data.incident.number}} {{data.incident.title}} ({{data.incident.severity}})","monitor":{{json data.monitor}},"missing":"{{data.nothing.here}}"}',
    });
    await api("post", "/incidents").send({ title: 'Said "quoted"\nand more', severity: "low" });
    await pump();
    const [req] = sentTo("templated");
    const body = JSON.parse(req?.body ?? "null") as Record<string, unknown>;
    expect(body).toEqual({
      text: expect.stringMatching(/^#\d+ Said "quoted"\nand more \(low\)$/),
      monitor: null,
      missing: "",
    });
    const signature = req?.headers?.["watchpost-signature"] ?? "";
    const timestamp = Number(/^t=(\d+)/.exec(signature)?.[1]);
    expect(signature).toBe(signWebhookBody(templated.secret, timestamp, req?.body ?? ""));
    await api("delete", `/webhooks/${templated.id}`);
  });

  it("retries a failing endpoint on the documented schedule, then gives up", async () => {
    const flaky = await endpoint("flaky", ["monitor.created"]);
    answers.set(url("flaky"), 503);
    await monitor("Second");
    await pump();
    const attempts = WEBHOOK_RETRY_MINUTES.length + 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const [delivery] = await deliveries(flaky.id);
      expect(sentTo("flaky")).toHaveLength(attempt);
      if (attempt === attempts) {
        expect(delivery).toMatchObject({ status: "failed", attempts, nextAttemptAt: null });
        break;
      }
      const wait = (WEBHOOK_RETRY_MINUTES[attempt - 1] ?? 0) * MINUTE;
      expect(delivery).toMatchObject({
        status: "pending",
        attempts: attempt,
        responseStatus: 503,
        error: "The endpoint answered HTTP 503.",
      });
      expect(new Date(delivery?.nextAttemptAt ?? 0).getTime()).toBe(clock.now().getTime() + wait);
      /* Not before it is due. */
      clock.advance(wait - 1_000);
      await webhooks().service.deliverDue();
      expect(sentTo("flaky")).toHaveLength(attempt);
      clock.advance(1_000);
      await webhooks().service.deliverDue();
    }
    /* Every attempt carried the same event ID, so the receiver can drop duplicates. */
    expect(new Set(sentTo("flaky").map((r) => r.headers?.["watchpost-event-id"])).size).toBe(1);
    expect(await view(flaky.id)).toMatchObject({ consecutiveFailures: 1, enabled: true });

    /* It recovers: the next event is delivered and the count starts over. */
    answers.set(url("flaky"), 204);
    await monitor("Third");
    await pump();
    expect((await deliveries(flaky.id))[0]).toMatchObject({ status: "delivered", attempts: 1 });
    expect(await view(flaky.id)).toMatchObject({ consecutiveFailures: 0 });
    await api("delete", `/webhooks/${flaky.id}`);
  }, 60_000);

  it("a delivery that succeeds on a retry is delivered once", async () => {
    const slow = await endpoint("slow", ["monitor.created"]);
    answers.set(url("slow"), "unreachable");
    await monitor("Fourth");
    await pump();
    expect((await deliveries(slow.id))[0]).toMatchObject({
      status: "pending",
      responseStatus: null,
      error: "No answer: connection refused",
    });
    answers.delete(url("slow"));
    clock.advance(MINUTE);
    expect(await webhooks().service.deliverDue()).toBeGreaterThanOrEqual(1);
    expect((await deliveries(slow.id))[0]).toMatchObject({ status: "delivered", attempts: 2 });
    clock.advance(DAY);
    await webhooks().service.deliverDue();
    expect(sentTo("slow")).toHaveLength(2);
    await api("delete", `/webhooks/${slow.id}`);
  });

  it("switches an endpoint off when it answers 410 Gone, or fails 20 deliveries in a row", async () => {
    const gone = await endpoint("gone", ["monitor.created"]);
    answers.set(url("gone"), 410);
    await monitor("Fifth");
    await pump();
    expect((await deliveries(gone.id))[0]).toMatchObject({ status: "failed", attempts: 1 });
    expect(await view(gone.id)).toMatchObject({
      enabled: false,
      disabledReason: "The endpoint answered 410 Gone.",
    });
    /* Off means no new deliveries. */
    await monitor("Sixth");
    await pump();
    expect(sentTo("gone")).toHaveLength(1);
    /* A person switches it back on, with a clean record. */
    answers.delete(url("gone"));
    const on = await api("patch", `/webhooks/${gone.id}`).send({ enabled: true });
    expect(on.body).toMatchObject({ enabled: true, disabledReason: null, consecutiveFailures: 0 });

    /* 19 failed deliveries so far, and one more that fails every attempt. */
    await ctx.container.infra.db.execute(
      sql`update webhook_endpoints set consecutive_failures = 19 where id = ${gone.id}`,
    );
    answers.set(url("gone"), 500);
    await monitor("Seventh");
    await pump();
    for (const minutes of WEBHOOK_RETRY_MINUTES) {
      clock.advance(minutes * MINUTE);
      await webhooks().service.deliverDue();
    }
    expect(await view(gone.id)).toMatchObject({
      enabled: false,
      disabledReason: "20 deliveries in a row failed.",
    });
    await api("delete", `/webhooks/${gone.id}`);
  }, 60_000);

  it("sends a test event and replays a past delivery, now", async () => {
    const before = sentTo("incidents").length;
    const tested = await api("post", `/webhooks/${incidentsOnly.id}/test`).send({
      type: "incident.resolved",
    });
    expect(tested.status, tested.text).toBe(200);
    expect(tested.body).toMatchObject({
      eventType: "incident.resolved",
      status: "delivered",
      manual: true,
      attempts: 1,
    });
    const test = bodyOf(sentTo("incidents")[before]);
    expect(test).toMatchObject({
      type: "incident.resolved",
      workspaceId: ws,
      data: { incident: { number: 42, status: "resolved" } },
    });

    /* A replay sends the stored event again, with the ID it had. */
    const original = (await deliveries(incidentsOnly.id))
      .filter((d) => d.eventType === "incident.triggered" && !d.manual)
      .at(-1);
    const replayed = await api(
      "post",
      `/webhooks/${incidentsOnly.id}/deliveries/${original?.id}/replay`,
    ).send({});
    expect(replayed.status, replayed.text).toBe(200);
    expect(replayed.body).toMatchObject({ eventType: "incident.triggered", manual: true });
    expect(replayed.body.id).not.toBe(original?.id);
    const again = bodyOf(sentTo("incidents").at(-1));
    expect(again).toEqual(bodyOf(sentTo("incidents")[0]));

    /* A failing test says so and isn't retried. */
    answers.set(url("incidents"), 500);
    const failed = await api("post", `/webhooks/${incidentsOnly.id}/test`).send({});
    expect(failed.body).toMatchObject({
      status: "failed",
      responseStatus: 500,
      nextAttemptAt: null,
    });
    answers.delete(url("incidents"));
    expect(
      (await api("post", `/webhooks/${incidentsOnly.id}/deliveries/${all.id}/replay`).send({}))
        .status,
    ).toBe(404);
  });

  it("changes what an endpoint gets, and deletes it with its deliveries", async () => {
    const edited = await api("patch", `/webhooks/${incidentsOnly.id}`).send({
      name: "Renamed",
      events: ["monitor.deleted"],
      headers: { "X-Team": "ops" },
    });
    expect(edited.status, edited.text).toBe(200);
    expect(edited.body).toMatchObject({
      name: "Renamed",
      events: ["monitor.deleted"],
      headerNames: ["X-Team"],
    });
    const before = sentTo("incidents").length;
    await api("delete", `/monitors/${monitorId}`);
    await pump();
    const last = sentTo("incidents").at(-1);
    expect(sentTo("incidents")).toHaveLength(before + 1);
    expect(bodyOf(last)).toMatchObject({
      type: "monitor.deleted",
      data: { monitor: { id: monitorId } },
    });
    expect(last?.headers?.["X-Team"]).toBe("ops");

    expect((await api("patch", `/webhooks/${incidentsOnly.id}`).send({})).status).toBe(400);
    expect((await api("delete", `/webhooks/${incidentsOnly.id}`)).status).toBe(204);
    expect((await api("delete", `/webhooks/${incidentsOnly.id}`)).status).toBe(404);
    const left = await ctx.container.infra.db.execute(
      sql`select 1 from webhook_deliveries where endpoint_id = ${incidentsOnly.id}`,
    );
    expect(left.rows).toEqual([]);
  });

  it("forgets deliveries after 30 days", async () => {
    expect((await deliveries(all.id)).length).toBeGreaterThan(0);
    clock.advance(31 * DAY);
    try {
      expect(await webhooks().service.purgeDeliveries()).toBeGreaterThan(0);
      expect(await deliveries(all.id)).toEqual([]);
    } finally {
      clock.advance(-31 * DAY);
    }
  });

  it("the Free plan has no webhooks: none are made and none are sent", async () => {
    clock.advance(20 * DAY);
    try {
      expect((await api("get", "/entitlements")).body.plan).toBe("free");
      const refused = await api("post", "/webhooks").send({
        name: "free",
        url: url("free"),
        events: ["*"],
      });
      expect(refused.status).toBe(402);
      const before = sentTo("all").length;
      await monitor("On Free");
      await pump();
      expect(sentTo("all")).toHaveLength(before);
      expect((await deliveries(all.id))[0]).toMatchObject({
        status: "failed",
        error: "The workspace's plan no longer includes webhooks.",
      });
    } finally {
      clock.advance(-20 * DAY);
    }
  });
});
