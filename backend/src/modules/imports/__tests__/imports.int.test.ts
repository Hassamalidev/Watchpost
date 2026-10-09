/*
 * P4-T07: fixture exports from each tool map at least 95% of their objects and list the rest with a
 * reason; a dry run creates nothing; applying creates what it promised and reports what failed.
 */
import { randomBytes } from "node:crypto";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ImportPlanView, ImportRunView, ImportSource } from "@app/shared";
import {
  WEB_ORIGIN,
  buildContainerApp,
  signUpVerified,
  stubHttp,
} from "../../../__tests__/helpers/container-app.js";
import { mapImport } from "../mappers.js";
import {
  betterStackFixture,
  opsgenieFixture,
  pagerDutyFixture,
  uptimeKumaFixture,
  uptimeRobotFixture,
} from "./fixtures.js";

const members = new Map([
  ["a@example.com", "0190e2e0-0000-7000-8000-00000000000a"],
  ["b@example.com", "0190e2e0-0000-7000-8000-00000000000b"],
]);
const byEmail = (email: string) => members.get(email);
const fixtures: Record<ImportSource, () => unknown> = {
  uptimerobot: uptimeRobotFixture,
  uptime_kuma: uptimeKumaFixture,
  better_stack: betterStackFixture,
  opsgenie: () => opsgenieFixture({ a: "a@example.com", b: "b@example.com" }),
  pagerduty: () => pagerDutyFixture({ a: "a@example.com", b: "b@example.com" }),
};

describe("mappers", () => {
  for (const source of Object.keys(fixtures) as ImportSource[]) {
    it(`${source}: maps at least 95% of the fixture and gives a reason for the rest`, () => {
      const items = mapImport(source, fixtures[source](), byEmail);
      const mapped = items.filter((i) => i.action === "create");
      const skipped = items.filter((i) => i.action === "skip");
      expect(items.length).toBeGreaterThanOrEqual(38);
      expect(mapped.length / items.length).toBeGreaterThanOrEqual(0.95);
      expect(skipped.length).toBeGreaterThan(0);
      for (const item of skipped) {
        expect(item.action === "skip" && item.reason.length, item.name).toBeGreaterThan(10);
      }
      for (const item of mapped) expect(item.becomes, item.name).toBeTruthy();
    });
  }

  it("reads UptimeRobot's keyword direction, ports and heartbeats", () => {
    const items = mapImport("uptimerobot", uptimeRobotFixture(), byEmail);
    const find = (name: string) => items.find((i) => i.name === name);
    /* keyword_type 2 alerts when the keyword is missing: it must be there. */
    expect(find("shop keyword")).toMatchObject({
      monitor: { config: { type: "keyword", keyword: "ok", mode: "contains" } },
    });
    expect(find("api keyword")).toMatchObject({
      monitor: { config: { keyword: "error", mode: "not_contains" } },
    });
    expect(find("port 5432")).toMatchObject({
      becomes: "Port 5432 check every 5 min",
      monitor: { config: { type: "tcp", host: "host-3.example.com", port: 5432 } },
    });
    expect(find("nightly job 0")).toMatchObject({
      monitor: {
        config: { type: "heartbeat", schedule: { kind: "period", periodSeconds: 86_400 } },
      },
    });
    expect(find("broken keyword")).toMatchObject({ action: "skip" });
    expect(find("mystery")).toMatchObject({ action: "skip" });
  });

  it("says why an Uptime Kuma check can't come over, and keeps upside-down mode", () => {
    const items = mapImport("uptime_kuma", uptimeKumaFixture(), byEmail);
    expect(items.find((i) => i.name === "postgres primary")).toMatchObject({
      action: "skip",
      reason: expect.stringContaining("private probes"),
    });
    expect(items.find((i) => i.name === "auth (kuma)")).toMatchObject({
      monitor: { settings: { upsideDown: true } },
    });
    expect(items.find((i) => i.name === "kuma dns 1")).toMatchObject({
      monitor: { config: { type: "dns", recordType: "MX" } },
    });
  });

  it("turns Opsgenie rotations and rule delays into ours, and names who is missing", () => {
    const items = mapImport("opsgenie", fixtures.opsgenie(), byEmail);
    const find = (name: string) => items.find((i) => i.name === name);
    /* A two-week rotation is a custom one of 336 hours. */
    expect(find("Team 4 schedule")).toMatchObject({
      schedule: { layers: [{ rotation: "custom", shiftHours: 336 }] },
    });
    expect(find("Team 2 schedule")?.becomes).toContain("without left@example.com");
    expect(find("Contractors")).toMatchObject({
      action: "skip",
      reason: expect.stringContaining("nobody@example.com"),
    });
    /* Opsgenie counts 0, 10 and 25 minutes from the start: ours are 0, then 10, then 15 later. */
    const escalation = find("Team 0 escalation");
    expect(
      escalation?.action === "create" && "escalation" in escalation
        ? escalation.escalation.steps.map((s) => s.delayMinutes)
        : [],
    ).toEqual([0, 10, 15]);
    expect(find("Vendor escalation")).toMatchObject({ action: "skip" });
  });

  it("turns PagerDuty layers, restrictions and rule delays into ours", () => {
    const items = mapImport("pagerduty", fixtures.pagerduty(), byEmail);
    const find = (name: string) => items.find((i) => i.name === name);
    const layerOf = (name: string) => {
      const item = find(name);
      return item?.action === "create" && "schedule" in item ? item.schedule.layers[0] : undefined;
    };
    /* People are referenced by ID; the users list says who they are (in any letter case). */
    expect(layerOf("Squad 0 on-call")).toMatchObject({
      rotation: "daily",
      startsAt: "2026-09-07T08:00:00.000Z",
      participants: [members.get("a@example.com"), members.get("b@example.com")],
      restrictions: [],
    });
    expect(layerOf("Squad 1 on-call")?.rotation).toBe("weekly");
    /* A two-week turn is a custom rotation of 336 hours. */
    expect(layerOf("Squad 4 on-call")).toMatchObject({ rotation: "custom", shiftHours: 336 });
    expect(find("Squad 2 on-call")?.becomes).toContain("without left@example.com");
    /* Someone PagerDuty no longer lists is named the way the reference names them. */
    expect(find("Squad 3 on-call")?.becomes).toContain("without Someone Deleted");
    /* 09:00 for eight hours every day; Saturday 22:00 for ten hours runs past midnight. */
    expect(layerOf("Squad 5 on-call")?.restrictions).toEqual([
      { days: [1, 2, 3, 4, 5, 6, 7], start: "09:00", end: "17:00" },
    ]);
    expect(layerOf("Squad 6 on-call")?.restrictions).toEqual([
      { days: [6], start: "22:00", end: "08:00" },
    ]);
    /* Monday 09:00 for five days has no counterpart: the layer comes over and the import says so. */
    expect(layerOf("Squad 7 on-call")?.restrictions).toEqual([]);
    expect(find("Squad 7 on-call")?.becomes).toContain("set them by hand");
    expect(find("Contractors")).toMatchObject({
      action: "skip",
      reason: expect.stringContaining("left@example.com"),
    });

    /* PagerDuty waits 10 minutes after the first rule and 15 after the second. */
    const escalation = find("Squad 0 escalation");
    expect(
      escalation?.action === "create" && "escalation" in escalation
        ? {
            delays: escalation.escalation.steps.map((s) => s.delayMinutes),
            targets: escalation.escalation.steps.map((s) => s.targets.map((t) => t.type)),
            schedules: escalation.scheduleNames,
            repeat: escalation.escalation.repeat,
          }
        : undefined,
    ).toEqual({
      delays: [0, 10, 15],
      targets: [["schedule"], ["user"], ["user"]],
      schedules: ["Squad 0 on-call", "", ""],
      repeat: 0,
    });
    expect(find("Squad 1 escalation")?.becomes).toBe("3 steps, without left@example.com");
    expect(find("Vendor escalation")).toMatchObject({
      action: "skip",
      reason: expect.stringContaining("schedule Contractors"),
    });
  });

  it("keeps the wait of a PagerDuty rule whose targets don't exist here", () => {
    const items = mapImport(
      "pagerduty",
      {
        users: [{ id: "PA", email: "a@example.com" }],
        escalation_policies: [
          {
            name: "Gap",
            escalation_rules: [
              { escalation_delay_in_minutes: 5, targets: [{ id: "PA", type: "user_reference" }] },
              { escalation_delay_in_minutes: 20, targets: [{ id: "PX", type: "user_reference" }] },
              { escalation_delay_in_minutes: 30, targets: [{ id: "PA", type: "user" }] },
            ],
          },
        ],
      },
      byEmail,
    );
    expect(items).toMatchObject([
      { escalation: { steps: [{ delayMinutes: 0 }, { delayMinutes: 25 }] } },
    ]);
  });

  it("refuses something that isn't the tool's export", () => {
    expect(() => mapImport("pagerduty", { services: [] }, byEmail)).toThrow(/PagerDuty/);
    expect(() => mapImport("uptimerobot", { hello: "world" }, byEmail)).toThrow(/getMonitors/);
    expect(() => mapImport("uptime_kuma", [], byEmail)).toThrow(/monitorList/);
    expect(() => mapImport("better_stack", {}, byEmail)).toThrow(/Better Stack/);
    expect(() => mapImport("opsgenie", { teams: [] }, byEmail)).toThrow(/Opsgenie/);
  });
});

describe("imports over HTTP", () => {
  const http = stubHttp((req) => {
    if (!req.url.startsWith("https://api.uptimerobot.com/")) return undefined;
    const form = new URLSearchParams(req.body ?? "");
    if (form.get("api_key") !== "ur-readonly-key-123") {
      return { body: JSON.stringify({ stat: "fail", error: { type: "invalid_parameter" } }) };
    }
    const all = uptimeRobotFixture().monitors;
    const offset = Number(form.get("offset") ?? 0);
    return {
      body: JSON.stringify({
        stat: "ok",
        pagination: { offset, limit: 50, total: all.length },
        monitors: all.slice(offset, offset + 50),
      }),
    };
  });
  const ctx = buildContainerApp({ authRateLimit: false, http });
  const run = randomBytes(4).toString("hex");
  const ownerEmail = `imports-owner-${run}@example.com`;
  const memberEmail = `imports-member-${run}@example.com`;
  let owner: TestAgent;
  let member: TestAgent;
  let ws = "";

  const api = (agent: TestAgent, method: "get" | "post", path: string) =>
    agent[method](`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN);
  const count = async (path: string) =>
    ((await api(owner, "get", path)).body.data as unknown[]).length;

  beforeAll(async () => {
    owner = request.agent(ctx.app);
    member = request.agent(ctx.app);
    await signUpVerified(ctx, owner, ownerEmail);
    await signUpVerified(ctx, member, memberEmail);
    const created = await owner
      .post("/api/auth/organization/create")
      .set("Origin", WEB_ORIGIN)
      .send({ name: "Imports Co", slug: `imports-${run}` });
    ws = created.body.id as string;
    const invite = await owner
      .post("/api/auth/organization/invite-member")
      .set("Origin", WEB_ORIGIN)
      .send({ email: memberEmail, role: "member", organizationId: ws });
    await member
      .post("/api/auth/organization/accept-invitation")
      .set("Origin", WEB_ORIGIN)
      .send({ invitationId: invite.body.id });
  }, 120_000);

  afterAll(async () => {
    await ctx.container.close();
  });

  it("is for admins, and a dry run creates nothing", async () => {
    const body = { source: "uptime_kuma", data: uptimeKumaFixture() };
    expect((await api(member, "post", "/imports/dry-run").send(body)).status).toBe(403);
    const plan = await api(owner, "post", "/imports/dry-run").send(body);
    expect(plan.status, plan.text).toBe(200);
    const view = plan.body as ImportPlanView;
    expect(view.total).toBe(43);
    expect(view.mapped).toBe(41);
    expect(view.coveragePercent).toBeGreaterThanOrEqual(95);
    expect(view.items.filter((i) => i.action === "skip").map((i) => i.name)).toEqual([
      "postgres primary",
      "docker: worker",
    ]);
    expect(await count("/monitors?limit=100")).toBe(0);
    expect(await count("/imports")).toBe(0);
    const empty = await api(owner, "post", "/imports/dry-run").send({ source: "uptime_kuma" });
    expect(empty.status).toBe(400);
  });

  it("creates schedules and escalation policies from Opsgenie, matching people by email", async () => {
    const applied = await api(owner, "post", "/imports").send({
      source: "opsgenie",
      data: opsgenieFixture({ a: ownerEmail, b: memberEmail }),
    });
    expect(applied.status, applied.text).toBe(201);
    const run = applied.body as ImportRunView;
    expect(run.total).toBe(42);
    expect(run.created).toBe(40);
    expect(run.failed).toBe(0);
    expect(run.coveragePercent).toBeGreaterThanOrEqual(95);
    expect(await count("/schedules")).toBe(20);
    const policies = (await api(owner, "get", "/escalation-policies")).body.data as {
      name: string;
      steps: { targets: { type: string; name: string | null }[] }[];
    }[];
    expect(policies).toHaveLength(20);
    /* The first step pages the schedule that was imported under the same name. */
    const team3 = policies.find((p) => p.name === "Team 3 escalation");
    expect(team3?.steps[0]?.targets[0]).toEqual(
      expect.objectContaining({ type: "schedule", name: "Team 3 schedule" }),
    );
    expect(await count("/imports")).toBe(1);
  });

  it("creates schedules and escalation policies from PagerDuty", async () => {
    const before = await count("/schedules");
    const applied = await api(owner, "post", "/imports").send({
      source: "pagerduty",
      data: pagerDutyFixture({ a: ownerEmail, b: memberEmail }),
    });
    expect(applied.status, applied.text).toBe(201);
    const run = applied.body as ImportRunView;
    expect(run.total).toBe(42);
    expect(run.created).toBe(40);
    expect(run.failed).toBe(0);
    expect(await count("/schedules")).toBe(before + 20);
    const policies = (await api(owner, "get", "/escalation-policies")).body.data as {
      name: string;
      steps: { delayMinutes: number; targets: { type: string; name: string | null }[] }[];
    }[];
    const squad3 = policies.find((p) => p.name === "Squad 3 escalation");
    expect(squad3?.steps.map((s) => s.delayMinutes)).toEqual([0, 10, 15]);
    expect(squad3?.steps[0]?.targets[0]).toEqual(
      expect.objectContaining({ type: "schedule", name: "Squad 3 on-call" }),
    );
  });

  it("reads UptimeRobot with an API key it never stores, and reports what the plan refused", async () => {
    const wrong = await api(owner, "post", "/imports/dry-run").send({
      source: "uptimerobot",
      apiKey: "not-the-right-key",
    });
    expect(wrong.status).toBe(400);
    const other = await api(owner, "post", "/imports/dry-run").send({
      source: "better_stack",
      apiKey: "ur-readonly-key-123",
    });
    expect(other.status).toBe(400);

    const applied = await api(owner, "post", "/imports").send({
      source: "uptimerobot",
      apiKey: "ur-readonly-key-123",
    });
    expect(applied.status, applied.text).toBe(201);
    const run = applied.body as ImportRunView;
    expect(run.total).toBe(44);
    expect(run.mapped).toBe(42);
    /* Whatever the plan allows was created; the rest is listed with the reason, not dropped. */
    expect(run.created + run.failed).toBe(42);
    expect(run.created).toBeGreaterThan(0);
    for (const item of run.items.filter((i) => i.result === "failed")) {
      expect(item.error?.length ?? 0).toBeGreaterThan(10);
    }
    expect(await count("/monitors?limit=100")).toBeGreaterThan(0);
    /* The key appears nowhere in what we kept. */
    const history = await api(owner, "get", "/imports");
    expect(JSON.stringify(history.body)).not.toContain("ur-readonly-key-123");
    expect((history.body.data as ImportRunView[]).map((r) => r.source)).toEqual([
      "uptimerobot",
      "pagerduty",
      "opsgenie",
    ]);
  });
});
