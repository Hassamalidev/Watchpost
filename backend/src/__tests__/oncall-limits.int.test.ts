/*
 * Plan limits on Phase 4 objects (PRODUCT.md §5): during the Pro trial schedules, escalation
 * policies and inbound sources are unlimited; on Free there are no schedules or escalation policies
 * and one inbound source, and the API says so with 402 instead of creating them.
 */
import { randomBytes } from "node:crypto";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeClock } from "../core/clock.js";
import { WEB_ORIGIN, buildContainerApp, signUpVerified } from "./helpers/container-app.js";

const clock = createFakeClock(new Date());
const ctx = buildContainerApp({ authRateLimit: false, clock });
const run = randomBytes(4).toString("hex");
let owner: TestAgent;
let ws = "";
let userId = "";

const api = (method: "get" | "post", path: string) =>
  owner[method](`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN);
const schedule = (name: string) => ({
  name,
  timezone: "UTC",
  layers: [
    {
      name: "Weekly",
      rotation: "weekly",
      startsAt: new Date(clock.now().getTime() - 86_400_000).toISOString(),
      participants: [userId],
    },
  ],
});
const policy = (name: string) => ({
  name,
  steps: [{ delayMinutes: 0, targets: [{ type: "user", id: userId }] }],
});

beforeAll(async () => {
  owner = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `limits-${run}@example.com`);
  const created = await owner
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "Limits Co", slug: `limits-${run}` });
  ws = created.body.id as string;
  userId = (await api("get", "/members")).body.data[0].userId as string;
}, 120_000);

afterAll(async () => {
  await ctx.container.close();
});

describe("plan limits on on-call and inbound", () => {
  it("allows more than one of each during the Pro trial", async () => {
    expect((await api("get", "/entitlements")).body.plan).toBe("pro");
    for (const name of ["Primary", "Secondary"]) {
      expect((await api("post", "/schedules").send(schedule(name))).status).toBe(201);
      expect((await api("post", "/escalation-policies").send(policy(name))).status).toBe(201);
      expect((await api("post", "/inbound-sources").send({ name, kind: "generic" })).status).toBe(
        201,
      );
    }
  });

  it("refuses another one on Free, with a reason, and keeps what exists working", async () => {
    /* The 14-day trial ends; the workspace is on Free. */
    clock.advance(15 * 86_400_000);
    const plan = await api("get", "/entitlements");
    expect(plan.body.plan).toBe("free");
    expect(plan.body.limits).toMatchObject({
      onCallSchedules: 0,
      escalationPolicies: 0,
      inboundSources: 1,
    });

    const refusedSchedule = await api("post", "/schedules").send(schedule("Third"));
    expect(refusedSchedule.status).toBe(402);
    expect(refusedSchedule.body.detail).toBe(
      "Your plan doesn't include on-call schedules. Upgrade to add one.",
    );
    const refusedPolicy = await api("post", "/escalation-policies").send(policy("Third"));
    expect(refusedPolicy.status).toBe(402);
    expect(refusedPolicy.body.detail).toContain("escalation policies");
    const refusedSource = await api("post", "/inbound-sources").send({
      name: "Third",
      kind: "generic",
    });
    expect(refusedSource.status).toBe(402);
    expect(refusedSource.body.detail).toBe(
      "Your plan allows 1 inbound source. Upgrade to add more.",
    );

    /* Nothing that was set up during the trial is taken away or stops answering. */
    const schedules = await api("get", "/schedules");
    expect(schedules.status).toBe(200);
    expect(schedules.body.data).toHaveLength(2);
    expect(schedules.body.data[0].onCall?.userId).toBe(userId);
    expect((await api("get", "/escalation-policies")).body.data).toHaveLength(2);
  });
});
