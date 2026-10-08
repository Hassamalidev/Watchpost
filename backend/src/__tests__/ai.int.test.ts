/*
 * P5-T01 against the real database with a stand-in for the model: every call is metered into the
 * usage ledger, the workspace's monthly budget cuts further calls off, and feedback on an answer is
 * stored. No request ever leaves the machine.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { v7 as uuidv7 } from "uuid";
import { PLANS } from "../config/plans.js";
import { createWorkspaceScope } from "../core/workspace-scope.js";
import { createFakeAiClient } from "../infra/anthropic/index.js";
import type { AiModule } from "../modules/ai/index.js";
import { EXPLAINER_CASES } from "../modules/ai/evals/fixtures.js";
import { WEB_ORIGIN, buildContainerApp, signUpVerified } from "./helpers/container-app.js";

/* Each call "uses" 60,000 input tokens: 0.06 USD, so the Free budget of 0.10 USD is gone after two. */
const client = createFakeAiClient(() => EXPLAINER_CASES[0]?.answer, {
  inputTokens: 60_000,
  outputTokens: 0,
});
const ctx = buildContainerApp({
  authRateLimit: false,
  ai: client,
  /* Other test files share the database and the platform-wide allowance; take it out of the way. */
  env: { UNFUNDED_AI_MONTHLY_CAP_USD: "10000" },
});
const run = randomBytes(4).toString("hex");
let owner: TestAgent;
let outsider: TestAgent;
let ws = "";

const ai = () => (ctx.container.modules.find((m) => m.name === "ai") as AiModule).service;
const scope = () => createWorkspaceScope({ workspaceId: ws });
const explain = (refId: string) =>
  ai().generate(scope(), {
    prompt: "explainer",
    refId,
    evidence: EXPLAINER_CASES[0]?.evidence ?? {},
  });

beforeAll(async () => {
  owner = request.agent(ctx.app);
  outsider = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `ai-${run}@example.com`);
  const created = await owner
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "AI Co", slug: `ai-${run}` });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id as string;
  await signUpVerified(ctx, outsider, `ai-out-${run}@example.com`);
  await outsider
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "Other", slug: `ai-other-${run}` });
}, 120_000);

afterAll(async () => {
  await ctx.container.close();
});

describe("AI generations", () => {
  let generationId = "";

  it("a call is stored and metered into the usage ledger, once", async () => {
    expect(PLANS.free.aiBudgetMicros).toBe(100_000);
    const refId = uuidv7();
    const result = await explain(refId);
    if (!result.ok) throw new Error(`expected an answer, got ${result.reason}`);
    generationId = result.generationId;
    expect(result.output.headline).toBe(EXPLAINER_CASES[0]?.answer.headline);

    const { rows: usage } = await ctx.container.infra.db.execute<{
      provider: string;
      kind: string;
      units: number;
      cost_micros: string;
    }>(sql`
      select provider, kind, units, cost_micros from usage_ledger
      where workspace_id = ${ws} and ref = ${generationId}`);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ provider: "anthropic", kind: "explainer", units: 60_000 });
    expect(Number(usage[0]?.cost_micros)).toBe(60_000);

    const { rows: stored } = await ctx.container.infra.db.execute<{
      status: string;
      prompt_version: number;
      cost_micros: number;
      ref_id: string;
    }>(sql`
      select status, prompt_version, cost_micros, ref_id from ai_generations where id = ${generationId}`);
    expect(stored[0]).toEqual({
      status: "ok",
      prompt_version: 1,
      cost_micros: 60_000,
      ref_id: refId,
    });
    /* What was sent had its secrets taken out. */
    for (const secret of EXPLAINER_CASES[0]?.secrets ?? []) {
      expect(client.requests.at(-1)?.user).not.toContain(secret);
    }
  });

  it("budget cutoff: once the month's budget is used, no more calls are made", async () => {
    const before = client.requests.length;
    /* 0.06 of 0.10 USD is used: one more call is allowed and takes the workspace over. */
    expect((await explain(uuidv7())).ok).toBe(true);
    expect(client.requests.length).toBe(before + 1);

    const refId = uuidv7();
    expect(await explain(refId)).toEqual({ ok: false, status: "skipped", reason: "budget_used" });
    expect(await explain(uuidv7())).toMatchObject({ ok: false, reason: "budget_used" });
    expect(client.requests.length).toBe(before + 1);

    const { rows } = await ctx.container.infra.db.execute<{ status: string; reason: string }>(sql`
      select status, reason from ai_generations where workspace_id = ${ws} and ref_id = ${refId}`);
    expect(rows).toEqual([{ status: "skipped", reason: "budget_used" }]);
    const { rows: spent } = await ctx.container.infra.db.execute<{ total: string }>(sql`
      select coalesce(sum(cost_micros), 0) as total from usage_ledger
      where workspace_id = ${ws} and provider = 'anthropic'`);
    expect(Number(spent[0]?.total)).toBe(120_000);
  });

  it("feedback on an answer is stored, changed and cleared by people who respond to incidents", async () => {
    const put = (agent: TestAgent, feedback: string | null, id = generationId, workspace = ws) =>
      agent
        .put(`/api/w/${workspace}/ai/generations/${id}/feedback`)
        .set("Origin", WEB_ORIGIN)
        .send({ feedback });
    const up = await put(owner, "up");
    expect(up.status, up.text).toBe(200);
    expect(up.body).toEqual({ generationId, feedback: "up" });
    expect((await put(owner, "down")).body.feedback).toBe("down");
    const read = await owner
      .get(`/api/w/${ws}/ai/generations/${generationId}`)
      .set("Origin", WEB_ORIGIN);
    expect(read.body).toEqual({ generationId, feedback: "down" });
    expect((await put(owner, null)).body.feedback).toBeNull();
    expect((await put(owner, "maybe")).status).toBe(400);
    expect((await put(owner, "up", uuidv7())).status).toBe(404);

    /* Another workspace can't rate it, through our workspace or their own. */
    expect([403, 404]).toContain((await put(outsider, "up")).status);
    const theirs = (await outsider.get("/api/auth/organization/list").set("Origin", WEB_ORIGIN))
      .body as Array<{ id: string }>;
    expect((await put(outsider, "up", generationId, theirs[0]?.id ?? "")).status).toBe(404);
  });
});
