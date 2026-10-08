/*
 * P6-T06: someone who doesn't find an integration in the gallery can say so, and the wish is
 * logged once per workspace and day, within a daily limit.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { WEB_ORIGIN, buildContainerApp, signUpVerified } from "./helpers/container-app.js";

const ctx = buildContainerApp({ authRateLimit: false });
const run = randomBytes(4).toString("hex");
let owner: TestAgent;
let ws = "";

const ask = (name: unknown) =>
  owner.post(`/api/w/${ws}/integration-requests`).set("Origin", WEB_ORIGIN).send({ name });
const logged = async () =>
  (
    await ctx.container.infra.db.execute<{ name: string }>(
      sql`select name from integration_requests where workspace_id = ${ws} order by created_at, name`,
    )
  ).rows.map((r) => r.name);

beforeAll(async () => {
  owner = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `wish-${run}@example.com`);
  const created = await owner
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "Wish Co", slug: `wish-${run}` });
  ws = created.body.id as string;
}, 120_000);

afterAll(async () => {
  await ctx.container.close();
});

describe("integration requests", () => {
  it("logs a wish once, however it is typed", async () => {
    expect((await ask("  Signal   Messenger ")).status).toBe(202);
    expect((await ask("signal messenger")).status).toBe(202);
    expect(await logged()).toEqual(["signal messenger"]);
    expect((await ask("x")).status).toBe(400);
    expect((await ask("y".repeat(81))).status).toBe(400);
    expect(
      (await request(ctx.app).post(`/api/w/${ws}/integration-requests`).send({ name: "line" }))
        .status,
    ).toBe(401);
  });

  it("stops after 20 different wishes in a day", async () => {
    for (let i = 0; i < 19; i += 1) expect((await ask(`tool ${i}`)).status).toBe(202);
    const over = await ask("one too many");
    expect(over.status).toBe(429);
    expect(await logged()).toHaveLength(20);
    /* A wish already made today is still accepted: it adds nothing. */
    expect((await ask("tool 3")).status).toBe(202);
  });
});
