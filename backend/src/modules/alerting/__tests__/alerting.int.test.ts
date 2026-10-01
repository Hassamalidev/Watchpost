/*
 * P1-T12 AC against the real database: planning is idempotent, a delivery that already went out is
 * never sent again, a failing adapter retries and then falls back (delivery failed, channel failing,
 * `delivery_failed` on the timeline, one admin email per hour), policies route per monitor, and
 * reminders repeat while the incident is open. The alerting service is built here with a fake
 * adapter and captured jobs; everything else is the real container.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { z } from "zod";
import { channelRulesSchema } from "@app/shared";
import { createFakeClock } from "../../../core/clock.js";
import { createWorkspaceScope, type WorkspaceScope } from "../../../core/workspace-scope.js";
import type { EnqueueOptions } from "../../../infra/queues/index.js";
import { newId } from "../../../infra/ids.js";
import {
  ChannelDeliveryError,
  createChannelsModule,
  renderPlain,
  type ChannelAdapter,
} from "../../channels/index.js";
import type { IncidentsModule } from "../../incidents/index.js";
import type { WorkspacesModule } from "../../workspaces/index.js";
import { createAlertingRepository } from "../alerting.repository.js";
import {
  NOTIFY_ATTEMPTS,
  RetryDeliveryError,
  createAlertingService,
  type AlertingService,
  type TimerJob,
} from "../alerting.service.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  signUpVerified,
} from "../../../__tests__/helpers/container-app.js";

function fakeAdapter() {
  const sent: Array<{ title: string; idempotencyKey: string; threadRef: string | null }> = [];
  let failures = 0;
  let permanent = false;
  const adapter: ChannelAdapter<{ url: string }> = {
    type: "webhook",
    parseConfig: (input) => z.object({ url: z.url() }).parse(input),
    render: renderPlain,
    async send(_config, message, meta) {
      if (failures > 0) {
        failures -= 1;
        throw new ChannelDeliveryError("HTTP 503 from the webhook", permanent);
      }
      sent.push({ title: message.title, ...meta });
      return { providerRef: `msg-${sent.length}` };
    },
  };
  return {
    adapter,
    sent,
    failNext(n: number, isPermanent = false) {
      failures = n;
      permanent = isPermanent;
    },
  };
}

let ctx: ReturnType<typeof buildContainerApp>;
let owner: TestAgent;
let ws: string;
let scope: WorkspaceScope;
let incidents: IncidentsModule;
let service: AlertingService;
let channels: ReturnType<typeof createChannelsModule>;
const fake = fakeAdapter();
const clock = createFakeClock();
const notifyJobs: Array<{ deliveryId: string; options: EnqueueOptions }> = [];
const timerJobs: Array<{ job: TimerJob; options: EnqueueOptions }> = [];

const db = () => ctx.container.infra.db;
const post = (path: string, body: object) => owner.post(path).set("Origin", WEB_ORIGIN).send(body);

async function createMonitor(name: string, settings: object = {}) {
  const res = await post(`/api/w/${ws}/monitors`, {
    settings: { name, regions: ["eu-central"], ...settings },
    config: { type: "tcp", host: "example.com", port: 443 },
  });
  expect(res.status, res.text).toBe(201);
  return res.body.id as string;
}

async function openIncident(monitorId: string, severity: "critical" | "high" | "low" = "critical") {
  const { incident } = await db().transaction((tx) =>
    incidents.service.openForMonitor(tx, {
      workspaceId: ws,
      monitorId,
      title: "Checkout is down",
      severity,
      causeCode: "connect_refused",
      failingRegions: ["eu-central"],
    }),
  );
  return incident;
}

async function channel(name: string) {
  const created = await channels.service.create(scope, {
    type: "webhook",
    name,
    config: { url: "https://hooks.example.com/alert" },
  });
  return created.id;
}

async function useChannels(channelIds: string[], events: Record<string, boolean> = {}) {
  const [policy] = await service.listPolicies(scope);
  await service.updatePolicy(scope, policy?.id ?? "", {
    rules: { channelIds, events: { ...policy?.rules.events, ...events } },
  });
}

const rows = async <T>(query: ReturnType<typeof sql>) => (await db().execute(query)).rows as T[];

beforeAll(async () => {
  ctx = buildContainerApp();
  owner = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `alert-owner-${randomBytes(4).toString("hex")}@example.com`);
  const created = await post("/api/auth/organization/create", {
    name: "Alert Co",
    slug: `alert-co-${randomBytes(4).toString("hex")}`,
  });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id;
  scope = createWorkspaceScope({ workspaceId: ws, role: "owner" });

  const find = <T>(name: string) => ctx.container.modules.find((m) => m.name === name) as T;
  incidents = find<IncidentsModule>("incidents");
  const workspaces = find<WorkspacesModule>("workspaces");
  channels = createChannelsModule({
    infra: ctx.container.infra,
    guards: workspaces.guards,
    adapters: [fake.adapter],
  });
  clock.set(new Date());
  service = createAlertingService({
    db: db(),
    repository: createAlertingRepository(),
    incidents: incidents.service,
    channels: channels.service,
    workspaces: workspaces.service,
    outbox: ctx.container.infra.outbox,
    clock,
    logger: ctx.container.infra.logger,
    newId,
    webOrigin: WEB_ORIGIN,
    enqueueNotify: async (deliveryId, options) => {
      notifyJobs.push({ deliveryId, options });
    },
    enqueueTimer: async (job, options) => {
      timerJobs.push({ job, options });
    },
  });
});

afterAll(async () => {
  await ctx.container.close();
});

describe("planning", () => {
  it("creates one delivery and one notify job per policy channel, once per event", async () => {
    const [a, b] = [await channel("Ops hook"), await channel("Backup hook")];
    await useChannels([a, b]);
    const incident = await openIncident(await createMonitor("Plan"));

    const first = await service.planIncidentEvent({
      kind: "triggered",
      incidentId: incident.id,
      eventKey: "evt-plan-1",
    });
    expect(first).toBe(2);
    const again = await service.planIncidentEvent({
      kind: "triggered",
      incidentId: incident.id,
      eventKey: "evt-plan-1",
    });
    expect(again).toBe(0);
    expect(notifyJobs.slice(-2).map((j) => j.options)).toEqual([
      expect.objectContaining({
        attempts: NOTIFY_ATTEMPTS,
        jobId: expect.stringMatching(/^notify\./),
      }),
      expect.objectContaining({ attempts: NOTIFY_ATTEMPTS }),
    ]);
  });

  it("skips events the policy turns off", async () => {
    const hook = await channel("Quiet hook");
    await useChannels([hook], { acknowledged: false });
    const incident = await openIncident(await createMonitor("Quiet"));
    expect(
      await service.planIncidentEvent({
        kind: "acknowledged",
        incidentId: incident.id,
        eventKey: "evt-quiet",
      }),
    ).toBe(0);
    await useChannels([hook], { acknowledged: true });
  });

  it("asks only channels whose own rules accept the event and the severity", async () => {
    const chat = await channel("Everything hook");
    const pager = await channels.service.create(scope, {
      type: "webhook",
      name: "Pager hook",
      config: { url: "https://hooks.example.com/pager" },
      rules: channelRulesSchema.parse({ minSeverity: "high", events: { reminder: false } }),
    });
    expect(pager.rules).toMatchObject({ minSeverity: "high", events: { reminder: false } });
    await useChannels([chat, pager.id]);
    const plan = (kind: "triggered" | "reminder" | "resolved", incidentId: string) =>
      service.planIncidentEvent({ kind, incidentId, eventKey: `evt-rules-${kind}-${incidentId}` });

    /* An expiring certificate (low) reaches chat but doesn't page. */
    const low = await openIncident(await createMonitor("Rules low"), "low");
    expect(await plan("triggered", low.id)).toBe(1);
    expect((await service.deliveriesFor(low.id)).map((d) => d.channelId)).toEqual([chat]);

    const critical = await openIncident(await createMonitor("Rules critical"));
    expect(await plan("triggered", critical.id)).toBe(2);
    expect(await plan("reminder", critical.id)).toBe(1);
    expect(await plan("resolved", critical.id)).toBe(2);

    /* "Send test" is the admin asking; the rules don't apply. */
    expect(await service.sendTest(scope, pager.id)).toEqual({ ok: true });

    /* Rules can change without touching the config, and `{}` resets them to everything. */
    const opened = await channels.service.update(scope, pager.id, {
      rules: channelRulesSchema.parse({}),
    });
    expect(opened.rules.minSeverity).toBe("low");
    const other = await openIncident(await createMonitor("Rules reopened"), "low");
    expect(await plan("triggered", other.id)).toBe(2);
  });

  it("routes a monitor with its own policy to that policy's channels", async () => {
    const own = await channel("Team hook");
    const policy = await service.createPolicy(scope, {
      name: "Payments team",
      rules: { channelIds: [own] },
    });
    const monitorId = await createMonitor("Payments", { alertPolicyId: policy.id });
    const incident = await openIncident(monitorId);
    await service.planIncidentEvent({
      kind: "triggered",
      incidentId: incident.id,
      eventKey: "evt-own",
    });
    const planned = await service.deliveriesFor(incident.id);
    expect(planned.map((d) => d.channelId)).toEqual([own]);
  });
});

describe("delivery", () => {
  it("sends once: a job that runs again after success sends nothing", async () => {
    const hook = await channel("Once hook");
    await useChannels([hook]);
    const incident = await openIncident(await createMonitor("Once"));
    await service.planIncidentEvent({
      kind: "triggered",
      incidentId: incident.id,
      eventKey: "evt-once",
    });
    const [delivery] = await service.deliveriesFor(incident.id);

    const before = fake.sent.length;
    expect(await service.deliver(delivery?.id ?? "")).toBe("sent");
    expect(await service.deliver(delivery?.id ?? "")).toBe("skipped");
    expect(fake.sent.length).toBe(before + 1);
    expect(fake.sent.at(-1)).toMatchObject({
      title: expect.stringContaining("Checkout is down"),
      idempotencyKey: `delivery.${delivery?.id}`,
      threadRef: null,
    });

    /* A follow-up threads under the first message. */
    await service.planIncidentEvent({
      kind: "resolved",
      incidentId: incident.id,
      eventKey: "evt-once-r",
    });
    const resolved = (await service.deliveriesFor(incident.id)).find((d) => d.kind === "resolved");
    expect(await service.deliver(resolved?.id ?? "")).toBe("sent");
    expect(fake.sent.at(-1)?.threadRef).toBe(`msg-${before + 1}`);
  });

  it("retries transient failures and sends once when the channel recovers", async () => {
    const hook = await channel("Flaky hook");
    await useChannels([hook]);
    const incident = await openIncident(await createMonitor("Flaky"));
    await service.planIncidentEvent({
      kind: "triggered",
      incidentId: incident.id,
      eventKey: "evt-flaky",
    });
    const [delivery] = await service.deliveriesFor(incident.id);
    const id = delivery?.id ?? "";

    fake.failNext(2);
    const before = fake.sent.length;
    await expect(service.deliver(id)).rejects.toBeInstanceOf(RetryDeliveryError);
    await expect(service.deliver(id)).rejects.toBeInstanceOf(RetryDeliveryError);
    expect(await service.deliver(id)).toBe("sent");
    expect(fake.sent.length).toBe(before + 1);

    const [after] = await service.deliveriesFor(incident.id);
    expect(after).toMatchObject({ status: "sent", attempts: 3 });
    const detail = await channels.service.get(scope, hook);
    expect(detail.status).toBe("healthy");
    expect(detail.lastError).toBe("HTTP 503 from the webhook");
  });

  it("falls back after the last attempt: failed delivery, failing channel, timeline, admin email", async () => {
    const hook = await channel("Dead hook");
    await useChannels([hook]);
    const incident = await openIncident(await createMonitor("Dead"));
    await service.planIncidentEvent({
      kind: "triggered",
      incidentId: incident.id,
      eventKey: "evt-dead",
    });
    const [delivery] = await service.deliveriesFor(incident.id);
    const id = delivery?.id ?? "";

    fake.failNext(NOTIFY_ATTEMPTS + 5);
    for (let attempt = 1; attempt < NOTIFY_ATTEMPTS; attempt += 1) {
      await expect(service.deliver(id)).rejects.toBeInstanceOf(RetryDeliveryError);
    }
    expect(await service.deliver(id)).toBe("failed");
    expect(await service.deliver(id)).toBe("skipped");
    fake.failNext(0);

    expect((await service.deliveriesFor(incident.id))[0]).toMatchObject({
      status: "failed",
      attempts: NOTIFY_ATTEMPTS,
      error: "HTTP 503 from the webhook",
    });
    expect((await channels.service.get(scope, hook)).status).toBe("failing");

    const health = await rows<{ payload: { status: string } }>(
      sql`select payload from outbox_events where type = 'channel.health_changed' and payload->>'channelId' = ${hook}`,
    );
    expect(health.map((h) => h.payload.status)).toEqual(["failing"]);

    const timeline = await rows<{ type: string; data: { channelName: string } }>(
      sql`select type, data from incident_events where incident_id = ${incident.id} order by at`,
    );
    expect(timeline.map((t) => t.type)).toEqual(["triggered", "delivery_failed"]);
    expect(timeline[1]?.data.channelName).toBe("Dead hook");

    const fallback = await rows<{ payload: { template: string; data: { channelName: string } } }>(
      sql`select payload from outbox_events where type = 'email.requested' and workspace_id = ${ws} and payload->>'template' = 'channel-failing'`,
    );
    expect(fallback).toHaveLength(1);
    expect(fallback[0]?.payload.data.channelName).toBe("Dead hook");
  });

  it("sends at most one fallback email per hour, and a success makes the channel healthy again", async () => {
    const hook = await channel("Revoked hook");
    await useChannels([hook]);
    const incident = await openIncident(await createMonitor("Revoked"));
    await service.planIncidentEvent({
      kind: "triggered",
      incidentId: incident.id,
      eventKey: "evt-revoked",
    });
    const [delivery] = await service.deliveriesFor(incident.id);

    /* A permanent error skips the remaining retries. */
    fake.failNext(1, true);
    expect(await service.deliver(delivery?.id ?? "")).toBe("failed");
    await service.onChannelHealth(hook, "failing");
    const fallback = await rows<{ n: number }>(
      sql`select count(*)::int as n from outbox_events where type = 'email.requested' and workspace_id = ${ws} and payload->>'template' = 'channel-failing'`,
    );
    expect(fallback[0]?.n).toBe(1);

    await service.planIncidentEvent({
      kind: "resolved",
      incidentId: incident.id,
      eventKey: "evt-revoked-r",
    });
    const resolved = (await service.deliveriesFor(incident.id)).find((d) => d.kind === "resolved");
    expect(await service.deliver(resolved?.id ?? "")).toBe("sent");
    expect((await channels.service.get(scope, hook)).status).toBe("healthy");
  });

  it("re-queues deliveries whose jobs were lost", async () => {
    const hook = await channel("Lost hook");
    await useChannels([hook]);
    const incident = await openIncident(await createMonitor("Lost"));
    await service.planIncidentEvent({
      kind: "triggered",
      incidentId: incident.id,
      eventKey: "evt-lost",
    });
    const [delivery] = await service.deliveriesFor(incident.id);
    await db().execute(
      sql`update notification_deliveries set updated_at = now() - interval '10 minutes' where id = ${delivery?.id}`,
    );
    const before = notifyJobs.length;
    expect(await service.recoverDeliveries()).toBeGreaterThanOrEqual(1);
    const requeued = notifyJobs.slice(before).find((j) => j.deliveryId === delivery?.id);
    expect(requeued?.options.jobId).toMatch(new RegExp(`^notify\\.${delivery?.id}\\.r\\d+$`));

    /* A second sweep before anything ran reuses the ID, so the queue drops the duplicate. */
    const again = notifyJobs.length;
    await service.recoverDeliveries();
    const second = notifyJobs.slice(again).find((j) => j.deliveryId === delivery?.id);
    expect(second?.options.jobId).toBe(requeued?.options.jobId);
  });

  it("leaves retries waiting out their backoff alone, and picks up stuck sends at once", async () => {
    const hook = await channel("Backoff hook");
    await useChannels([hook]);
    const incident = await openIncident(await createMonitor("Backoff"));
    await service.planIncidentEvent({
      kind: "triggered",
      incidentId: incident.id,
      eventKey: "evt-backoff",
    });
    const [delivery] = await service.deliveriesFor(incident.id);
    const requeued = async () => {
      const before = notifyJobs.length;
      await service.recoverDeliveries();
      return notifyJobs.slice(before).some((j) => j.deliveryId === delivery?.id);
    };
    /* Attempt 5 with a 60 s base waits 16 minutes; 6 minutes in, the job is still legitimately delayed. */
    await db().execute(
      sql`update notification_deliveries set status = 'retrying', attempts = 5, backoff_ms = 60000, updated_at = now() - interval '6 minutes' where id = ${delivery?.id}`,
    );
    expect(await requeued()).toBe(false);

    await db().execute(
      sql`update notification_deliveries set status = 'sending', attempts = 1, backoff_ms = 8000, updated_at = now() - interval '10 minutes' where id = ${delivery?.id}`,
    );
    expect(await requeued()).toBe(true);
  });
});

describe("reminders", () => {
  it("repeat every N minutes while open, skip nothing on replay, and stop when resolved", async () => {
    const hook = await channel("Reminder hook");
    await useChannels([hook]);
    const incident = await openIncident(await createMonitor("Reminded", { reminderMinutes: 5 }));
    const startedAt = incident.startedAt.getTime();
    clock.set(new Date(startedAt + 1_000));

    expect(await service.scheduleReminders(incident.id)).toBe(true);
    const first = timerJobs.at(-1);
    expect(first?.job).toEqual({
      kind: "reminder",
      incidentId: incident.id,
      dueAt: startedAt + 300_000,
    });

    clock.set(new Date(startedAt + 300_000));
    expect(await service.reminderDue(incident.id, startedAt + 300_000)).toBe(1);
    expect(await service.reminderDue(incident.id, startedAt + 300_000)).toBe(0);
    expect(timerJobs.at(-1)?.job.dueAt).toBe(startedAt + 600_000);
    expect((await service.deliveriesFor(incident.id)).map((d) => d.kind)).toEqual(["reminder"]);

    await db().transaction((tx) =>
      incidents.service.resolveForMonitor(tx, { monitorId: incident.monitorId ?? "", auto: true }),
    );
    const scheduled = timerJobs.length;
    clock.set(new Date(startedAt + 600_000));
    expect(await service.reminderDue(incident.id, startedAt + 600_000)).toBe(0);
    expect(timerJobs.length).toBe(scheduled);
  });

  it("monitors without reminders schedule none", async () => {
    const incident = await openIncident(await createMonitor("No reminders"));
    expect(await service.scheduleReminders(incident.id)).toBe(false);
  });
});
