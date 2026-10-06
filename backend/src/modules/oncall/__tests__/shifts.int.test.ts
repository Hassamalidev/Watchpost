/*
 * P4-T03c against the real container with a fake clock: one notice per shift start and end, none
 * twice, and none for a shift an override removed.
 */
import { randomBytes } from "node:crypto";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeClock } from "../../../core/clock.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  signUpVerified,
} from "../../../__tests__/helpers/container-app.js";
import type { OncallModule } from "../index.js";

/* Sunday 2026-10-11 12:00 UTC; the weekly handoff is on Mondays 09:00 UTC. */
const clock = createFakeClock("2026-10-11T12:00:00Z");
const ctx = buildContainerApp({ authRateLimit: false, clock });
const run = randomBytes(4).toString("hex");
const aliceEmail = `shift-alice-${run}@example.com`;
const bobEmail = `shift-bob-${run}@example.com`;

let alice: TestAgent;
let bob: TestAgent;
let ws = "";
let aliceId = "";
let bobId = "";
let scheduleId = "";

const oncall = () =>
  (ctx.container.modules.find((m) => m.name === "oncall") as OncallModule).service;
const api = (agent: TestAgent, method: "get" | "post", path: string) =>
  agent[method](`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN);

async function notices(to: string): Promise<{ kind: string; at: string; otherName?: string }[]> {
  const rows = await ctx.container.infra.pool.query<{
    data: { kind: string; at: string; otherName?: string };
  }>(
    `select payload->'data' as data from outbox_events
     where type = 'email.requested' and payload->>'to' = $1 and payload->>'template' = 'shift-notice'
     order by created_at`,
    [to],
  );
  return rows.rows.map((r) => r.data);
}
const kinds = async (to: string) => (await notices(to)).map((n) => `${n.kind}@${n.at}`);

beforeAll(async () => {
  alice = request.agent(ctx.app);
  bob = request.agent(ctx.app);
  await signUpVerified(ctx, alice, aliceEmail);
  await signUpVerified(ctx, bob, bobEmail);
  const created = await alice
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "Shift Co", slug: `shift-${run}` });
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
  const schedule = await api(alice, "post", "/schedules").send({
    name: "Primary",
    timezone: "UTC",
    layers: [
      {
        name: "Weekly",
        rotation: "weekly",
        startsAt: "2026-10-05T09:00:00Z",
        participants: [aliceId, bobId],
      },
    ],
  });
  expect(schedule.status, schedule.text).toBe(201);
  scheduleId = schedule.body.id as string;
}, 120_000);

afterAll(async () => {
  await ctx.container.close();
});

describe("shift notices", () => {
  it("says nothing while nobody's shift starts or ends", async () => {
    await oncall().notifyShifts();
    expect(await kinds(aliceEmail)).toEqual([]);
    expect(await kinds(bobEmail)).toEqual([]);
  });

  it("tells both people at the handoff, once", async () => {
    clock.set("2026-10-12T09:00:30Z");
    await oncall().notifyShifts();
    const handoff = "2026-10-12T09:00:00.000Z";
    expect(await kinds(aliceEmail)).toEqual([`end@${handoff}`]);
    expect(await kinds(bobEmail)).toEqual([`start@${handoff}`]);
    const [started] = await notices(bobEmail);
    expect(started).toMatchObject({ scheduleName: "Primary", until: "2026-10-19T09:00:00.000Z" });
    expect(started?.otherName).toBeTruthy();

    /* The sweep runs every minute and looks half an hour back; nothing is said twice. */
    clock.advance(60_000);
    await oncall().notifyShifts();
    clock.advance(10 * 60_000);
    await oncall().notifyShifts();
    expect(await kinds(aliceEmail)).toHaveLength(1);
    expect(await kinds(bobEmail)).toHaveLength(1);
  });

  it("announces an override's start and end like any shift", async () => {
    clock.set("2026-10-14T08:00:00Z");
    const added = await api(bob, "post", `/schedules/${scheduleId}/overrides`).send({
      userId: aliceId,
      startsAt: "2026-10-14T10:00:00Z",
      endsAt: "2026-10-14T14:00:00Z",
    });
    expect(added.status, added.text).toBe(201);

    clock.set("2026-10-14T10:00:20Z");
    await oncall().notifyShifts();
    expect(await kinds(aliceEmail)).toContain("start@2026-10-14T10:00:00.000Z");
    expect(await kinds(bobEmail)).toContain("end@2026-10-14T10:00:00.000Z");

    clock.set("2026-10-14T14:00:20Z");
    await oncall().notifyShifts();
    expect(await kinds(aliceEmail)).toContain("end@2026-10-14T14:00:00.000Z");
    expect(await kinds(bobEmail)).toContain("start@2026-10-14T14:00:00.000Z");
  });

  it("sends nothing for a shift an override removed", async () => {
    /* Alice's next week (from the 19th) is covered by Bob for the whole week: no handoff happens. */
    clock.set("2026-10-18T12:00:00Z");
    const before = { alice: (await kinds(aliceEmail)).length, bob: (await kinds(bobEmail)).length };
    const added = await api(bob, "post", `/schedules/${scheduleId}/overrides`).send({
      userId: bobId,
      startsAt: "2026-10-19T09:00:00Z",
      endsAt: "2026-10-26T09:00:00Z",
    });
    expect(added.status, added.text).toBe(201);

    clock.set("2026-10-19T09:00:30Z");
    await oncall().notifyShifts();
    expect(await kinds(aliceEmail)).toHaveLength(before.alice);
    expect(await kinds(bobEmail)).toHaveLength(before.bob);
  });
});
