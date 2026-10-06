/*
 * P4-T04 against the real container with a fake clock: an escalation policy pages step by step
 * (a person, then whoever is on call for a schedule), repeats its rounds, stops for good the moment
 * someone acknowledges, and "escalate now" runs the next step at once.
 */
import { randomBytes } from "node:crypto";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EscalationPolicyView, IncidentEscalationView } from "@app/shared";
import { createFakeClock } from "../core/clock.js";
import type { AlertingModule } from "../modules/alerting/index.js";
import { WEB_ORIGIN, buildContainerApp, signUpVerified } from "./helpers/container-app.js";

const clock = createFakeClock(new Date());
const ctx = buildContainerApp({ authRateLimit: false, clock });
const run = randomBytes(4).toString("hex");
const aliceEmail = `esc-alice-${run}@example.com`;
const bobEmail = `esc-bob-${run}@example.com`;
const MINUTE = 60_000;

let alice: TestAgent;
let bob: TestAgent;
let ws = "";
let aliceId = "";
let bobId = "";
let policyId = "";

const alerting = () =>
  (ctx.container.modules.find((m) => m.name === "alerting") as AlertingModule).service;
const api = (agent: TestAgent, method: "get" | "post" | "patch" | "delete", path: string) =>
  agent[method](`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN);

/* Opens an incident and does what the `incident.triggered` handler does. */
async function openIncident(title: string) {
  const created = await api(alice, "post", "/incidents").send({ title, severity: "critical" });
  expect(created.status, created.text).toBe(201);
  const incident = { id: created.body.id as string, number: created.body.number as number };
  expect(await alerting().startEscalation(incident.id)).toBe(true);
  return incident;
}

/* Who has a delivery planned for this incident, in the order the steps ran. */
async function paged(incidentId: string): Promise<string[]> {
  const rows = await ctx.container.infra.pool.query<{ event_key: string; user_id: string }>(
    `select event_key, user_id from notification_deliveries
     where incident_id = $1 and user_id is not null order by event_key, created_at`,
    [incidentId],
  );
  return rows.rows.map(
    (r) => `${r.event_key.split(".").at(-1)}:${r.user_id === aliceId ? "alice" : "bob"}`,
  );
}

const state = async (incidentId: string) =>
  (await api(alice, "get", `/incidents/${incidentId}/escalation`)).body
    .data as IncidentEscalationView | null;

beforeAll(async () => {
  alice = request.agent(ctx.app);
  bob = request.agent(ctx.app);
  await signUpVerified(ctx, alice, aliceEmail);
  await signUpVerified(ctx, bob, bobEmail);
  const created = await alice
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "Escalation Co", slug: `esc-${run}` });
  ws = created.body.id as string;
  const invite = await alice
    .post("/api/auth/organization/invite-member")
    .set("Origin", WEB_ORIGIN)
    .send({ email: bobEmail, role: "responder", organizationId: ws });
  await bob
    .post("/api/auth/organization/accept-invitation")
    .set("Origin", WEB_ORIGIN)
    .send({ invitationId: invite.body.id });
  const members = await api(alice, "get", "/members");
  for (const m of members.body.data as { userId: string; email: string }[]) {
    if (m.email === aliceEmail) aliceId = m.userId;
    if (m.email === bobEmail) bobId = m.userId;
  }

  /* Bob is on call for the schedule the second step names. */
  const schedule = await api(alice, "post", "/schedules").send({
    name: "Backup",
    timezone: "UTC",
    layers: [
      {
        name: "Always Bob",
        rotation: "weekly",
        startsAt: new Date(clock.now().getTime() - 86_400_000).toISOString(),
        participants: [bobId],
      },
    ],
  });
  expect(schedule.status, schedule.text).toBe(201);

  const policy = await api(alice, "post", "/escalation-policies").send({
    name: "Primary then backup",
    repeat: 1,
    steps: [
      { delayMinutes: 0, targets: [{ type: "user", id: aliceId }] },
      { delayMinutes: 5, targets: [{ type: "schedule", id: schedule.body.id }] },
    ],
  });
  expect(policy.status, policy.text).toBe(201);
  const view = policy.body as EscalationPolicyView;
  policyId = view.id;
  expect(view.steps[1]?.targets[0]).toMatchObject({ type: "schedule", name: "Backup" });

  /* The default alert route pages through the policy. */
  const routes = await api(alice, "get", "/alert-policies");
  const route = (routes.body.data as { id: string; isDefault: boolean; rules: object }[]).find(
    (p) => p.isDefault,
  );
  const linked = await api(alice, "patch", `/alert-policies/${route?.id}`).send({
    rules: { ...route?.rules, escalationPolicyId: policyId },
  });
  expect(linked.status, linked.text).toBe(200);
}, 120_000);

afterAll(async () => {
  await ctx.container.close();
});

describe("escalation policies", () => {
  it("are defined by admins, with people who can be paged and schedules that exist", async () => {
    const body = {
      name: "Nope",
      steps: [{ delayMinutes: 0, targets: [{ type: "user", id: aliceId }] }],
    };
    expect((await api(bob, "post", "/escalation-policies").send(body)).status).toBe(403);
    const ghost = await api(alice, "post", "/escalation-policies").send({
      name: "Ghost",
      steps: [
        {
          delayMinutes: 0,
          targets: [{ type: "schedule", id: "0190e2e0-0000-7000-8000-00000000ffff" }],
        },
      ],
    });
    expect(ghost.status).toBe(400);
    const list = await api(bob, "get", "/escalation-policies");
    expect(list.status).toBe(200);
    expect((list.body.data as EscalationPolicyView[]).map((p) => p.id)).toContain(policyId);

    const unknown = await api(
      alice,
      "patch",
      "/alert-policies/0190e2e0-0000-7000-8000-00000000ffff",
    ).send({
      name: "x",
    });
    expect(unknown.status).toBe(404);
  });
});

describe("an escalating incident", () => {
  it("pages each step after its delay, round after round, until every step has run", async () => {
    const incident = await openIncident("Checkout down");
    const start = clock.now().getTime();
    expect(await state(incident.id)).toMatchObject({
      policyName: "Primary then backup",
      stepsRun: 0,
      totalSteps: 4,
      finished: null,
    });

    expect(await alerting().escalationDue(incident.id, 0, start)).toBe("ran");
    expect(await paged(incident.id)).toEqual(["0:alice"]);
    const afterFirst = await state(incident.id);
    expect(afterFirst?.stepsRun).toBe(1);
    expect(Date.parse(afterFirst?.nextStepAt ?? "")).toBe(start + 5 * MINUTE);

    /* The same job arriving again does nothing. */
    expect(await alerting().escalationDue(incident.id, 0, start)).toBe("stale");

    clock.advance(5 * MINUTE);
    expect(await alerting().escalationDue(incident.id, 1, start + 5 * MINUTE)).toBe("ran");
    expect(await paged(incident.id)).toEqual(["0:alice", "1:bob"]);

    /* Second round: the first step again, at once (its delay is 0), then the schedule after 5. */
    const round2 = clock.now().getTime();
    expect(await alerting().escalationDue(incident.id, 2, round2)).toBe("ran");
    clock.advance(5 * MINUTE);
    expect(await alerting().escalationDue(incident.id, 3, round2 + 5 * MINUTE)).toBe("ran");
    expect(await paged(incident.id)).toEqual(["0:alice", "1:bob", "2:alice", "3:bob"]);
    expect(await state(incident.id)).toMatchObject({
      stepsRun: 4,
      nextStepAt: null,
      finished: "exhausted",
    });

    const timeline = await api(alice, "get", `/incidents/${incident.number}`);
    const escalated = (
      timeline.body.timeline as { type: string; data: { step: number; round: number } }[]
    )
      .filter((e) => e.type === "escalated")
      .map((e) => `${e.data.round}.${e.data.step}`)
      .sort();
    expect(escalated).toEqual(["1.1", "1.2", "2.1", "2.2"]);
  });

  for (const ackAfter of [0, 1, 2, 3]) {
    it(`stops for good when acknowledged after ${ackAfter} step${ackAfter === 1 ? "" : "s"}`, async () => {
      const incident = await openIncident(`Ack after ${ackAfter}`);
      let due = clock.now().getTime();
      for (let step = 0; step < ackAfter; step += 1) {
        expect(await alerting().escalationDue(incident.id, step, due)).toBe("ran");
        const next = await state(incident.id);
        due = Date.parse(next?.nextStepAt ?? "");
        clock.set(new Date(due));
      }
      const before = await paged(incident.id);
      expect(before).toHaveLength(ackAfter);

      const ack = await api(bob, "post", `/incidents/${incident.number}/acknowledge`);
      expect(ack.status, ack.text).toBe(200);

      /* The timer still fires; it finds the incident taken and pages nobody. */
      expect(await alerting().escalationDue(incident.id, ackAfter, due)).toBe("stopped");
      clock.advance(60 * MINUTE);
      expect(await alerting().escalationDue(incident.id, ackAfter, due)).toBe("stale");
      expect(await alerting().escalationDue(incident.id, ackAfter + 1, due)).toBe("stale");
      expect(await paged(incident.id)).toEqual(before);
      expect(await state(incident.id)).toMatchObject({
        stepsRun: ackAfter,
        nextStepAt: null,
        finished: "acknowledged",
      });
      const now = await api(bob, "post", `/incidents/${incident.id}/escalate`);
      expect(now.status).toBe(409);
    });
  }

  it("runs the next step at once on 'escalate now', and the old timer finds nothing to do", async () => {
    const incident = await openIncident("Escalate now");
    const start = clock.now().getTime();
    expect(await alerting().escalationDue(incident.id, 0, start)).toBe("ran");
    const waitingFor = start + 5 * MINUTE;

    clock.advance(MINUTE);
    const viewer = await api(bob, "post", `/incidents/${incident.id}/escalate`);
    expect(viewer.status, viewer.text).toBe(200);
    expect((viewer.body.data as IncidentEscalationView).stepsRun).toBe(2);
    expect(await paged(incident.id)).toEqual(["0:alice", "1:bob"]);

    /* The delayed job for step 1 arrives four minutes later. */
    clock.set(new Date(waitingFor));
    expect(await alerting().escalationDue(incident.id, 1, waitingFor)).toBe("stale");
    expect(await paged(incident.id)).toEqual(["0:alice", "1:bob"]);
  });

  it("doesn't escalate when the alert route names no policy", async () => {
    const routes = await api(alice, "get", "/alert-policies");
    const route = (routes.body.data as { id: string; isDefault: boolean; rules: object }[]).find(
      (p) => p.isDefault,
    );
    await api(alice, "patch", `/alert-policies/${route?.id}`).send({
      rules: { ...route?.rules, escalationPolicyId: null },
    });
    const created = await api(alice, "post", "/incidents").send({
      title: "Quiet",
      severity: "high",
    });
    expect(await alerting().startEscalation(created.body.id as string)).toBe(false);
    expect(await state(created.body.id as string)).toBeNull();
    expect((await api(bob, "post", `/incidents/${created.body.id}/escalate`)).status).toBe(409);
  });
});
