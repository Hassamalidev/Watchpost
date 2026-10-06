/*
 * P1-T02 AC against real Postgres: new workspaces get default settings (and one workspace.created
 * event), only admins can edit, incident numbers are unique under concurrency, and the recovery sweep
 * repairs workspaces whose settings were never created.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { createWorkspaceScope } from "../../../core/workspace-scope.js";
import { createDbPool, type DbPool } from "../../../infra/db/index.js";
import { outboxEvents } from "../../../infra/outbox/index.js";
import { createRedis, type RedisClient } from "../../../infra/redis.js";
import { TEST_DATABASE_URL, TEST_REDIS_URL } from "../../../__tests__/helpers/test-env.js";
import {
  buildWorkspaceTestApp,
  createWorkspace,
  get,
  inviteAndAccept,
  patch,
  signUpAndVerify,
  uniqueEmail,
  type CapturedEmail,
} from "../../../__tests__/helpers/workspace-app.js";
import { workspaceSettings } from "../schema/workspace-settings.js";
import { TRIAL_DAYS } from "../index.js";

let pool: DbPool;
let redis: RedisClient;
const emails: CapturedEmail[] = [];
let ctx: ReturnType<typeof buildWorkspaceTestApp>;
let owner: TestAgent;
let admin: TestAgent;
let member: TestAgent;
let workspaceId: string;

beforeAll(async () => {
  pool = createDbPool(TEST_DATABASE_URL, { max: 25 });
  redis = createRedis(TEST_REDIS_URL);
  ctx = buildWorkspaceTestApp({ pool, redis, emails });
  owner = request.agent(ctx.app);
  admin = request.agent(ctx.app);
  member = request.agent(ctx.app);

  await signUpAndVerify(owner, emails, uniqueEmail("owner"), "Owner");
  workspaceId = await createWorkspace(owner, "Globex");

  const adminEmail = uniqueEmail("admin");
  await signUpAndVerify(admin, emails, adminEmail, "Admin");
  await inviteAndAccept(owner, admin, emails, workspaceId, adminEmail, "admin");

  const memberEmail = uniqueEmail("member");
  await signUpAndVerify(member, emails, memberEmail, "Member");
  await inviteAndAccept(owner, member, emails, workspaceId, memberEmail, "member");
});

afterAll(async () => {
  await pool.end();
  await redis.quit();
});

describe("defaults for new workspaces", () => {
  it("creates settings with UTC, incident sequence 0 and a 14-day trial", async () => {
    const [row] = await ctx.db
      .select()
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, workspaceId));
    expect(row).toMatchObject({ timezone: "UTC", incidentSeq: 0, flags: {} });
    const days = ((row?.trialEndsAt?.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(TRIAL_DAYS - 0.1);
    expect(days).toBeLessThanOrEqual(TRIAL_DAYS);
  });

  it("emits exactly one workspace.created event (alerting creates the default alert policy from it)", async () => {
    const events = await ctx.db
      .select()
      .from(outboxEvents)
      .where(
        and(eq(outboxEvents.type, "workspace.created"), eq(outboxEvents.workspaceId, workspaceId)),
      );
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ workspaceId });
  });
});

describe("reading and editing settings", () => {
  it("lets any member read settings", async () => {
    const res = await get(member, `/api/w/${workspaceId}/settings`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ workspaceId, timezone: "UTC" });
  });

  it("only admins and owners can edit", async () => {
    const asMember = await patch(member, `/api/w/${workspaceId}/settings`, {
      timezone: "Europe/Berlin",
    });
    expect(asMember.status).toBe(403);

    const asAdmin = await patch(admin, `/api/w/${workspaceId}/settings`, {
      timezone: "Asia/Karachi",
    });
    expect(asAdmin.status, asAdmin.text).toBe(200);
    expect(asAdmin.body.timezone).toBe("Asia/Karachi");

    const asOwner = await patch(owner, `/api/w/${workspaceId}/settings`, {
      timezone: "America/New_York",
    });
    expect(asOwner.status).toBe(200);
    expect((await get(member, `/api/w/${workspaceId}/settings`)).body.timezone).toBe(
      "America/New_York",
    );
  });

  it("validates the body with field errors", async () => {
    const bad = await patch(admin, `/api/w/${workspaceId}/settings`, { timezone: "Mars/Olympus" });
    expect(bad.status).toBe(400);
    const problem = JSON.parse(bad.text);
    expect(problem.code).toBe("validation_failed");
    expect(problem.errors[0].path).toBe("body.timezone");

    expect((await patch(admin, `/api/w/${workspaceId}/settings`, {})).status).toBe(400);
    expect(
      (await patch(admin, `/api/w/${workspaceId}/settings`, { plan: "business" })).status,
    ).toBe(400);
  });
});

describe("incident numbers", () => {
  it("are unique and sequential under concurrent transactions", async () => {
    const scope = createWorkspaceScope({ workspaceId });
    const numbers = await Promise.all(
      Array.from({ length: 20 }, () =>
        ctx.db.transaction((tx) => ctx.workspaces.service.nextIncidentNumber(tx, scope)),
      ),
    );
    expect([...numbers].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
});

describe("recovery sweep", () => {
  it("recreates settings for a workspace whose settings row is missing", async () => {
    const other = await createWorkspace(owner, "Initech");
    await ctx.db.delete(workspaceSettings).where(eq(workspaceSettings.workspaceId, other));

    const repaired = await ctx.workspaces.service.repairMissingSettings();
    expect(repaired).toBeGreaterThanOrEqual(1);
    const [row] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, other));
    expect(row?.n).toBe(1);
    expect(await ctx.workspaces.service.repairMissingSettings()).toBe(0);
  });
});
