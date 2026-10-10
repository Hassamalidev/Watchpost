/*
 * Requests that arrive together. Two things used to go wrong, both found by firing bursts at the
 * running app: many monitors created at once ran the database out of connections (51 of 60 failed
 * with a server error), and a plan's count of private probes or client workspaces could be passed
 * because each request counted before any had added its own.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { newId } from "../infra/ids.js";
import { WEB_ORIGIN, buildContainerApp, signUpVerified } from "./helpers/container-app.js";

const ctx = buildContainerApp({ authRateLimit: false });
const run = randomBytes(4).toString("hex");
let owner: TestAgent;
let ws = "";

const post = (path: string, body: object) =>
  owner.post(`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN).send(body);
const count = (statuses: number[], status: number) => statuses.filter((s) => s === status).length;

beforeAll(async () => {
  owner = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `burst-${run}@example.com`);
  const created = await owner
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "Burst Co", slug: `burst-${run}` });
  ws = created.body.id as string;
}, 120_000);

afterAll(async () => {
  await ctx.container.close();
});

describe("requests that arrive together", () => {
  it("creates 40 monitors at once without one server error", async () => {
    const statuses = (
      await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          post("/monitors", {
            settings: { name: `Burst ${i}`, regions: ["eu-central"] },
            config: { type: "http", url: "https://example.com" },
          }),
        ),
      )
    ).map((res) => res.status);
    expect(count(statuses, 201), JSON.stringify(statuses)).toBe(40);
    const stored = await ctx.container.infra.db.execute<{ n: number }>(
      sql`select count(*)::int as n from monitors where workspace_id = ${ws}`,
    );
    expect(stored.rows[0]?.n).toBe(40);
  }, 60_000);

  it("keeps to the plan's number of private probes", async () => {
    /* The trial plan includes one. */
    const statuses = (
      await Promise.all(
        Array.from({ length: 8 }, (_, i) => post("/private-probes", { name: `Probe ${i}` })),
      )
    ).map((res) => res.status);
    expect(count(statuses, 201), JSON.stringify(statuses)).toBe(1);
    expect(count(statuses, 402)).toBe(7);
  }, 60_000);

  it("keeps to the plan's number of client workspaces", async () => {
    const start = new Date(Date.now() - 86_400_000).toISOString();
    const end = new Date(Date.now() + 29 * 86_400_000).toISOString();
    await ctx.container.infra.db.execute(sql`
      insert into subscriptions (id, workspace_id, paddle_subscription_id, paddle_customer_id, status,
        plan_key, billing_interval, items, period_start, period_end, paid_period_start, paid_period_end,
        last_event_at)
      values (${newId()}, ${ws}, ${`sub_${run}`}, ${`ctm_${run}`}, 'active', 'business', 'month',
        '[]'::jsonb, ${start}::timestamptz, ${end}::timestamptz, ${start}::timestamptz, ${end}::timestamptz,
        ${start}::timestamptz)`);
    /* Business includes ten. */
    const statuses = (
      await Promise.all(
        Array.from({ length: 14 }, (_, i) => post("/client-workspaces", { name: `Client ${i}` })),
      )
    ).map((res) => res.status);
    expect(count(statuses, 201), JSON.stringify(statuses)).toBe(10);
    expect(count(statuses, 402)).toBe(4);
    const linked = await ctx.container.infra.db.execute<{ n: number }>(
      sql`select count(*)::int as n from workspace_parents where parent_id = ${ws}`,
    );
    expect(linked.rows[0]?.n).toBe(10);
  }, 120_000);
});
