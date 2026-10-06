/*
 * P3-T01 AC through the real composition: every limit that has a feature today is enforced by the
 * server (monitors, heartbeats, check interval, regions, history, members), and a downgrade pauses the
 * monitors over the limit instead of deleting them. The trial end is the downgrade used here; P3-T03's
 * AC (trial expiry with a fake clock) is covered by the same flow.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import request from "supertest";
import { createFakeClock } from "../../../core/clock.js";
import { createWorkspaceScope } from "../../../core/workspace-scope.js";
import { emailFromOutbox, signUpVerified } from "../../../__tests__/helpers/container-app.js";
import {
  buildBillingApp,
  checkoutData,
  deliverAndProcess,
  eventsOf,
  fakePaddleApi,
  get,
  paddleEvent,
  post,
  PRICES,
  signUpWithWorkspace,
  subscriptionFixture,
  subscriptionPayload,
  type BillingApp,
} from "../../../__tests__/helpers/billing.js";

const DAY = 86_400_000;
const clock = createFakeClock(new Date());
const paddle = fakePaddleApi(clock);
let ctx: BillingApp;
let owner: Awaited<ReturnType<typeof signUpWithWorkspace>>;
let ws: string;
const monitorIds: string[] = [];

async function createMonitor(name: string, settings: object = {}) {
  return post(owner.agent, `/api/w/${ws}/monitors`, {
    settings: { name, regions: ["eu-central"], intervalSeconds: 180, ...settings },
    config: { type: "tcp", host: "example.com", port: 443 },
  });
}

const entitlements = async () => (await get(owner.agent, `/api/w/${ws}/entitlements`)).body;
const listMonitors = async () =>
  (await get(owner.agent, `/api/w/${ws}/monitors?limit=100`)).body.data as Array<{
    id: string;
    paused: boolean;
    pausedReason: string | null;
    intervalSeconds: number;
    regions: string[];
    minFailingRegions: number;
  }>;

beforeAll(async () => {
  ctx = buildBillingApp(clock, paddle);
  owner = await signUpWithWorkspace(ctx, "limits");
  ws = owner.workspaceId;
  await ctx.billing.service.ensureAccount(ws);
});

afterAll(async () => {
  await ctx.container.close();
});

describe("trial entitlements", () => {
  it("gives a new workspace the Pro plan for 14 days without a card", async () => {
    const body = await entitlements();
    expect(body).toMatchObject({ plan: "pro", planName: "Pro", source: "trial" });
    expect(body.limits).toMatchObject({
      monitors: 150,
      minIntervalSeconds: 30,
      members: "unlimited",
    });
    const ends = Date.parse(body.trialEndsAt);
    expect(Math.round((ends - clock.now().getTime()) / DAY)).toBe(14);
  });

  it("is readable by members only", async () => {
    expect((await request(ctx.app).get(`/api/w/${ws}/entitlements`)).status).toBe(401);
    const stranger = await signUpWithWorkspace(ctx, "limits-other");
    expect((await get(stranger.agent, `/api/w/${ws}/entitlements`)).status).toBe(404);
    expect((await get(stranger.agent, `/api/w/${ws}/billing`)).status).toBe(404);
    expect((await get(stranger.agent, `/api/w/${ws}/monitor-usage`)).status).toBe(404);
  });

  it("allows Pro settings during the trial", async () => {
    for (let i = 0; i < 22; i += 1) {
      const res = await createMonitor(`m${i}`, {
        intervalSeconds: i < 3 ? 30 : 180,
        regions: i < 3 ? ["eu-central", "us-east", "ap-southeast"] : ["eu-central"],
        ...(i < 3 ? { minFailingRegions: 3 } : { minFailingRegions: 1 }),
      });
      expect(res.status, res.text).toBe(201);
      monitorIds.push(res.body.id);
    }
    const usage = await get(owner.agent, `/api/w/${ws}/monitor-usage`);
    expect(usage.body).toEqual({
      monitors: { used: 22, limit: 150 },
      heartbeats: { used: 0, limit: 75 },
      pausedByPlan: 0,
    });
  });
});

describe("trial end (downgrade to Free)", () => {
  it("drops to Free when the trial ends and announces it once", async () => {
    clock.advance(14 * DAY + 60_000);
    expect(await entitlements()).toMatchObject({ plan: "free", source: "free", trialEndsAt: null });
    expect(await ctx.billing.service.runClock()).toBeGreaterThanOrEqual(1);
    expect(await ctx.billing.service.ensureAccount(ws)).toBeNull();
    expect(await eventsOf(ctx, ws, "billing.plan_changed")).toEqual([{ from: "pro", to: "free" }]);
  });

  it("pauses the newest monitors over the limit, slows fast checks, and deletes nothing", async () => {
    const scope = createWorkspaceScope({ workspaceId: ws });
    expect(await ctx.monitors.service.enforcePlanLimits(scope)).toEqual({
      paused: 2,
      resumed: 0,
      adjusted: 3,
    });
    const monitors = await listMonitors();
    expect(monitors).toHaveLength(22);
    const paused = monitors.filter((m) => m.paused);
    expect(paused.map((m) => m.id).sort()).toEqual(monitorIds.slice(20).sort());
    expect(paused.every((m) => m.pausedReason === "plan_limit")).toBe(true);
    for (const id of monitorIds.slice(0, 3)) {
      const m = monitors.find((x) => x.id === id);
      expect(m).toMatchObject({ intervalSeconds: 180, minFailingRegions: 2 });
      expect(m?.regions).toEqual(["eu-central", "us-east"]);
    }
    /* Running it again changes nothing. */
    expect(await ctx.monitors.service.enforcePlanLimits(scope)).toEqual({
      paused: 0,
      resumed: 0,
      adjusted: 0,
    });
    expect((await get(owner.agent, `/api/w/${ws}/monitor-usage`)).body).toEqual({
      monitors: { used: 20, limit: 20 },
      heartbeats: { used: 0, limit: 5 },
      pausedByPlan: 2,
    });
  });

  it("enforces Free limits on new and resumed monitors", async () => {
    const overCount = await createMonitor("one too many");
    expect(overCount.status).toBe(402);
    expect(overCount.body.code).toBe("quota_exceeded");
    expect((await post(owner.agent, `/api/w/${ws}/monitors/${monitorIds[21]}/resume`)).status).toBe(
      402,
    );

    /* Make room, then the per-monitor limits still apply. */
    expect((await post(owner.agent, `/api/w/${ws}/monitors/${monitorIds[0]}/pause`)).status).toBe(
      200,
    );
    expect((await createMonitor("too fast", { intervalSeconds: 60 })).status).toBe(402);
    expect(
      (await createMonitor("too wide", { regions: ["eu-central", "us-east", "ap-southeast"] }))
        .status,
    ).toBe(402);
    /* The user picks which monitors stay active: a plan-paused one can take the free slot. */
    const swapped = await post(owner.agent, `/api/w/${ws}/monitors/${monitorIds[21]}/resume`);
    expect(swapped.status, swapped.text).toBe(200);
    expect(swapped.body).toMatchObject({ paused: false, pausedReason: null });
  });

  it("limits heartbeat monitors separately", async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await post(owner.agent, `/api/w/${ws}/monitors`, {
        settings: { name: `hb${i}`, intervalSeconds: 180 },
        config: { type: "heartbeat", schedule: { kind: "period", periodSeconds: 3_600 } },
      });
      expect(res.status, res.text).toBe(201);
    }
    const sixth = await post(owner.agent, `/api/w/${ws}/monitors`, {
      settings: { name: "hb6", intervalSeconds: 180 },
      config: { type: "heartbeat", schedule: { kind: "period", periodSeconds: 3_600 } },
    });
    expect(sixth.status).toBe(402);
  });

  it("refuses chart history beyond the plan's window", async () => {
    const id = monitorIds[1];
    expect((await get(owner.agent, `/api/w/${ws}/monitors/${id}/latency?range=30d`)).status).toBe(
      200,
    );
    const tooFar = await get(owner.agent, `/api/w/${ws}/monitors/${id}/latency?range=90d`);
    expect(tooFar.status).toBe(402);
    expect(tooFar.body.detail).toContain("30 days");
  });

  it("limits members to the plan (Free: 3)", async () => {
    const invite = async (label: string) => {
      const agent = request.agent(ctx.app);
      const email = `${label}-${randomBytes(4).toString("hex")}@example.com`;
      await signUpVerified(ctx, agent, email);
      const sent = await post(owner.agent, "/api/auth/organization/invite-member", {
        email,
        role: "member",
        organizationId: ws,
      });
      if (sent.status !== 200) return sent.status;
      const { url } = await emailFromOutbox(ctx.container, email, "invite");
      const accepted = await post(agent, "/api/auth/organization/accept-invitation", {
        invitationId: String(url).split("/").at(-1),
      });
      return accepted.status;
    };
    expect(await invite("second")).toBe(200);
    expect(await invite("third")).toBe(200);
    expect(await invite("fourth")).not.toBe(200);
    const state = await get(owner.agent, `/api/w/${ws}/billing`);
    expect(state.body.usage.members).toEqual({ used: 3, limit: 3 });
  });
});

describe("upgrade", () => {
  it("resumes plan-paused monitors when a paid plan starts", async () => {
    const now = clock.now();
    const data = subscriptionFixture(
      {
        priceId: PRICES.starterMonth,
        periodStart: now,
        periodEnd: new Date(now.getTime() + 30 * DAY),
        customData: await checkoutData(owner),
      },
      now,
    );
    paddle.put(data);
    expect(
      await deliverAndProcess(
        ctx,
        paddleEvent("subscription.created", subscriptionPayload(data), now),
      ),
    ).toBe("applied");
    expect(await entitlements()).toMatchObject({ plan: "starter", source: "subscription" });
    expect((await eventsOf(ctx, ws, "billing.plan_changed"))[0]).toEqual({
      from: "free",
      to: "starter",
    });

    const result = await ctx.monitors.service.enforcePlanLimits(
      createWorkspaceScope({ workspaceId: ws }),
    );
    expect(result).toMatchObject({ paused: 0, resumed: 1 });
    const monitors = await listMonitors();
    expect(monitors.filter((m) => m.pausedReason === "plan_limit")).toHaveLength(0);
    /* A monitor the user paused stays paused. */
    expect(monitors.find((m) => m.id === monitorIds[0])).toMatchObject({
      paused: true,
      pausedReason: "user",
    });
    expect((await createMonitor("starter speed", { intervalSeconds: 60 })).status).toBe(201);
    expect(
      (await get(owner.agent, `/api/w/${ws}/monitors/${monitorIds[1]}/latency?range=90d`)).status,
    ).toBe(200);
  });
});
