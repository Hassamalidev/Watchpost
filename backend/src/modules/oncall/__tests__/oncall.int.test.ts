/*
 * P4-T03a against the real container: schedules over HTTP (who may define, override and read them),
 * who is on call now and next, and a timeline that agrees with the on-call answer.
 */
import { randomBytes } from "node:crypto";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OnCallNow, OnCallSegment, ScheduleSummary, ScheduleView } from "@app/shared";
import { createFakeClock } from "../../../core/clock.js";
import { createWorkspaceScope } from "../../../core/workspace-scope.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  signUpVerified,
} from "../../../__tests__/helpers/container-app.js";
import type { OncallModule } from "../index.js";

/* Wednesday 2026-10-07 12:00 UTC. */
const clock = createFakeClock("2026-10-07T12:00:00Z");
const ctx = buildContainerApp({ authRateLimit: false, clock });
const run = randomBytes(4).toString("hex");
const emails = {
  owner: `oncall-owner-${run}@example.com`,
  responder: `oncall-responder-${run}@example.com`,
  viewer: `oncall-viewer-${run}@example.com`,
};

const agents = {} as Record<keyof typeof emails, TestAgent>;
const ids = {} as Record<keyof typeof emails, string>;
let ws = "";
let scheduleId = "";

const api = (who: keyof typeof emails, method: "get" | "post" | "patch" | "delete", path: string) =>
  agents[who][method](`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN);
const auth = (who: keyof typeof emails, path: string, body: object) =>
  agents[who].post(`/api/auth/organization${path}`).set("Origin", WEB_ORIGIN).send(body);

/* Weekly handoff on Mondays 09:00 UTC, owner first. */
const weekly = () => ({
  name: "Primary",
  timezone: "UTC",
  layers: [
    {
      name: "Weekly",
      rotation: "weekly",
      startsAt: "2026-10-05T09:00:00Z",
      participants: [ids.owner, ids.responder],
    },
  ],
});

beforeAll(async () => {
  for (const who of Object.keys(emails) as (keyof typeof emails)[]) {
    agents[who] = request.agent(ctx.app);
    await signUpVerified(ctx, agents[who], emails[who]);
  }
  const created = await auth("owner", "/create", { name: "On-call", slug: `oncall-${run}` });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id as string;
  for (const who of ["responder", "viewer"] as const) {
    const invite = await auth("owner", "/invite-member", {
      email: emails[who],
      role: who,
      organizationId: ws,
    });
    expect(invite.status, invite.text).toBe(200);
    const accept = await auth(who, "/accept-invitation", { invitationId: invite.body.id });
    expect(accept.status, accept.text).toBe(200);
  }
  const members = await api("owner", "get", "/members");
  for (const m of members.body.data as { userId: string; email: string }[]) {
    const who = (Object.keys(emails) as (keyof typeof emails)[]).find((k) => emails[k] === m.email);
    if (who !== undefined) ids[who] = m.userId;
  }
}, 120_000);

afterAll(async () => {
  await ctx.container.close();
});

describe("schedules", () => {
  it("lets admins define a schedule and everyone but billing read it", async () => {
    const denied = await api("responder", "post", "/schedules").send(weekly());
    expect(denied.status).toBe(403);

    const created = await api("owner", "post", "/schedules").send(weekly());
    expect(created.status, created.text).toBe(201);
    const view = created.body as ScheduleView;
    scheduleId = view.id;
    expect(view.layers[0]?.participants.map((p) => p.userId)).toEqual([ids.owner, ids.responder]);
    expect(view.layers[0]?.participants[0]?.name).toBeTruthy();

    const list = await api("viewer", "get", "/schedules");
    expect(list.status, list.text).toBe(200);
    const mine = (list.body.data as ScheduleSummary[]).find((s) => s.id === scheduleId);
    expect(mine?.onCall?.userId).toBe(ids.owner);
  });

  it("refuses a bad time zone and people who can't be paged", async () => {
    const zone = await api("owner", "post", "/schedules").send({
      ...weekly(),
      timezone: "Mars/Olympus",
    });
    expect(zone.status).toBe(400);
    const viewer = weekly();
    viewer.layers[0]?.participants.push(ids.viewer);
    const person = await api("owner", "post", "/schedules").send(viewer);
    expect(person.status, person.text).toBe(400);
    const custom = weekly();
    (custom.layers[0] as { rotation: string }).rotation = "custom";
    expect((await api("owner", "post", "/schedules").send(custom)).status).toBe(400);
  });

  it("says who is on call now and who takes over next", async () => {
    const now = await api("viewer", "get", `/schedules/${scheduleId}/on-call`);
    expect(now.status, now.text).toBe(200);
    const body = now.body as OnCallNow;
    expect(body.current?.user?.userId).toBe(ids.owner);
    expect(body.current?.layerName).toBe("Weekly");
    expect(body.current?.endsAt).toBe("2026-10-12T09:00:00.000Z");
    expect(body.next?.user?.userId).toBe(ids.responder);
    expect(body.next?.startsAt).toBe("2026-10-12T09:00:00.000Z");

    const later = await api("viewer", "get", `/schedules/${scheduleId}/on-call`).query({
      at: "2026-10-13T00:00:00Z",
    });
    expect((later.body as OnCallNow).current?.user?.userId).toBe(ids.responder);
  });

  it("lets a responder cover a stretch with an override, and take it back", async () => {
    expect(
      (
        await api("viewer", "post", `/schedules/${scheduleId}/overrides`).send({
          userId: ids.responder,
          startsAt: "2026-10-07T11:00:00Z",
          endsAt: "2026-10-07T18:00:00Z",
        })
      ).status,
    ).toBe(403);

    const added = await api("responder", "post", `/schedules/${scheduleId}/overrides`).send({
      userId: ids.responder,
      startsAt: "2026-10-07T11:00:00Z",
      endsAt: "2026-10-07T18:00:00Z",
    });
    expect(added.status, added.text).toBe(201);

    const now = (await api("viewer", "get", `/schedules/${scheduleId}/on-call`)).body as OnCallNow;
    expect(now.current?.user?.userId).toBe(ids.responder);
    expect(now.current?.source).toBe("override");
    expect(now.current?.endsAt).toBe("2026-10-07T18:00:00.000Z");
    expect(now.next?.user?.userId).toBe(ids.owner);

    const system = createWorkspaceScope({ workspaceId: ws });
    const oncall = (ctx.container.modules.find((m) => m.name === "oncall") as OncallModule).service;
    expect(await oncall.whoIsOnCall(system, scheduleId, clock.now())).toBe(ids.responder);

    const view = (await api("viewer", "get", `/schedules/${scheduleId}`)).body as ScheduleView;
    expect(view.overrides).toHaveLength(1);

    const past = await api("responder", "post", `/schedules/${scheduleId}/overrides`).send({
      userId: ids.responder,
      startsAt: "2026-10-01T00:00:00Z",
      endsAt: "2026-10-02T00:00:00Z",
    });
    expect(past.status).toBe(400);
    const stranger = await api("responder", "post", `/schedules/${scheduleId}/overrides`).send({
      userId: ids.viewer,
      startsAt: "2026-10-08T00:00:00Z",
      endsAt: "2026-10-09T00:00:00Z",
    });
    expect(stranger.status).toBe(400);

    const removed = await api(
      "responder",
      "delete",
      `/schedules/${scheduleId}/overrides/${added.body.id}`,
    );
    expect(removed.status).toBe(204);
    expect(await oncall.whoIsOnCall(system, scheduleId, clock.now())).toBe(ids.owner);
  });

  it("draws a timeline that agrees with the on-call answer on 30 random dates", async () => {
    const from = "2026-10-01T00:00:00Z";
    const to = "2026-11-25T00:00:00Z";
    const res = await api("viewer", "get", `/schedules/${scheduleId}/timeline`).query({ from, to });
    expect(res.status, res.text).toBe(200);
    const segments = res.body.data as OnCallSegment[];
    expect(segments[0]?.startsAt).toBe("2026-10-01T00:00:00.000Z");
    expect(segments[0]?.user).toBeNull();
    expect(segments.at(-1)?.endsAt).toBe("2026-11-25T00:00:00.000Z");

    let seed = 482;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const span = Date.parse(to) - Date.parse(from);
    for (let i = 0; i < 30; i += 1) {
      const at = new Date(Date.parse(from) + Math.floor(random() * span));
      const segment = segments.find(
        (s) => Date.parse(s.startsAt) <= at.getTime() && at.getTime() < Date.parse(s.endsAt),
      );
      const now = await api("viewer", "get", `/schedules/${scheduleId}/on-call`).query({
        at: at.toISOString(),
      });
      expect((now.body as OnCallNow).current?.user?.userId ?? null, at.toISOString()).toBe(
        segment?.user?.userId ?? null,
      );
    }

    const tooLong = await api("viewer", "get", `/schedules/${scheduleId}/timeline`).query({
      from,
      to: "2026-12-31T00:00:00Z",
    });
    expect(tooLong.status).toBe(400);
  });

  it("replaces the layers on edit and deletes the schedule", async () => {
    const edited = await api("owner", "patch", `/schedules/${scheduleId}`).send({
      name: "Primary (daily)",
      layers: [
        {
          name: "Daily",
          rotation: "daily",
          startsAt: "2026-10-07T00:00:00Z",
          participants: [ids.responder, ids.owner],
        },
      ],
    });
    expect(edited.status, edited.text).toBe(200);
    expect((edited.body as ScheduleView).layers.map((l) => l.name)).toEqual(["Daily"]);
    const now = (await api("viewer", "get", `/schedules/${scheduleId}/on-call`)).body as OnCallNow;
    expect(now.current?.user?.userId).toBe(ids.responder);

    expect((await api("responder", "delete", `/schedules/${scheduleId}`)).status).toBe(403);
    expect((await api("owner", "delete", `/schedules/${scheduleId}`)).status).toBe(204);
    expect((await api("viewer", "get", `/schedules/${scheduleId}`)).status).toBe(404);
  });
});
