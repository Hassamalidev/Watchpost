/*
 * P1-T26 AC through the real composition: a deploy recorded from a curl-style POST and from a signed
 * GitHub `deployment_status` webhook (retries recorded once, bad signatures refused). How deploys show
 * up in incidents is tested in incidents/__tests__/deploy-suspect.int.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  signUpVerified,
} from "../../../__tests__/helpers/container-app.js";

let ctx: ReturnType<typeof buildContainerApp>;
let owner: TestAgent;
let stranger: TestAgent;
let ws: string;
let hook: { url: string; githubUrl: string; githubSecret: string };

const post = (agent: TestAgent, path: string, body: object = {}) =>
  agent.post(path).set("Origin", WEB_ORIGIN).send(body);
const get = (agent: TestAgent, path: string) => agent.get(path).set("Origin", WEB_ORIGIN);
const pathOf = (url: string) => new URL(url).pathname;

async function createWorkspace(agent: TestAgent, name: string) {
  const res = await post(agent, "/api/auth/organization/create", {
    name,
    slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomBytes(4).toString("hex")}`,
  });
  expect(res.status, res.text).toBe(200);
  return res.body.id as string;
}

function github(event: string, payload: object, secret = hook.githubSecret) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return request(ctx.app)
    .post(pathOf(hook.githubUrl))
    .set("content-type", "application/json")
    .set("x-github-event", event)
    .set("x-hub-signature-256", signature)
    .send(body);
}

const deploymentStatus = (id: number, sha: string, state = "success") => ({
  deployment_status: {
    id,
    state,
    environment_url: "https://app.example.com",
    created_at: new Date().toISOString(),
  },
  deployment: { sha, ref: "main", environment: "production" },
  repository: { full_name: "acme/shop" },
});

beforeAll(async () => {
  ctx = buildContainerApp({ authRateLimit: false });
  owner = request.agent(ctx.app);
  stranger = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `dep-owner-${randomBytes(4).toString("hex")}@example.com`);
  ws = await createWorkspace(owner, "Deploys Co");
  await signUpVerified(ctx, stranger, `dep-other-${randomBytes(4).toString("hex")}@example.com`);
  await createWorkspace(stranger, "Other Co");
});

afterAll(async () => {
  await ctx.container.close();
});

describe("deploy URL", () => {
  it("is created by admins, shown once, and reported as configured", async () => {
    expect((await get(owner, `/api/w/${ws}/deploy-hook`)).body).toEqual({
      configured: false,
      createdAt: null,
    });
    const res = await post(owner, `/api/w/${ws}/deploy-hook`);
    expect(res.status, res.text).toBe(201);
    hook = res.body;
    expect(hook.url).toMatch(/\/api\/deploys\/[A-Za-z0-9_-]{32}$/);
    expect(hook.githubUrl).toBe(`${hook.url}/github`);
    expect((await get(owner, `/api/w/${ws}/deploy-hook`)).body.configured).toBe(true);
    expect((await post(stranger, `/api/w/${ws}/deploy-hook`)).status).toBe(404);
    expect((await request(ctx.app).get(`/api/w/${ws}/deploys`)).status).toBe(401);
  });

  it("records a deploy from a one-line POST", async () => {
    const res = await request(ctx.app)
      .post(pathOf(hook.url))
      .send({ version: "v1.4.2", service: "api", environment: "production" });
    expect(res.status, res.text).toBe(201);
    const list = await get(owner, `/api/w/${ws}/deploys`);
    expect(list.body.data[0]).toMatchObject({
      source: "api",
      version: "v1.4.2",
      service: "api",
      environment: "production",
    });
  });

  it("throttles a flood of posts to one URL", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 32; i += 1) {
      statuses.push(
        (await request(ctx.app).post("/api/deploys/flood-token-0000000000").send({})).status,
      );
      if (statuses.at(-1) === 429) break;
    }
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.length).toBeLessThanOrEqual(31);
  });

  it("refuses unknown tokens and bad input", async () => {
    expect(
      (await request(ctx.app).post("/api/deploys/not-a-real-token-123456").send({ version: "x" }))
        .status,
    ).toBe(404);
    expect((await request(ctx.app).post(pathOf(hook.url)).send({})).status).toBe(400);
    expect(
      (
        await request(ctx.app)
          .post(pathOf(hook.url))
          .send({ version: "x", url: "javascript:alert(1)" })
      ).status,
    ).toBe(400);
  });
});

describe("GitHub deployments", () => {
  it("records successful deployment statuses once, signed with the hook's secret", async () => {
    const first = await github("deployment_status", deploymentStatus(901, "abcdef1234567890"));
    expect(first.status, first.text).toBe(201);
    const retry = await github("deployment_status", deploymentStatus(901, "abcdef1234567890"));
    expect(retry.body).toEqual({ outcome: "duplicate" });

    const list = await get(owner, `/api/w/${ws}/deploys`);
    const fromGithub = (list.body.data as Array<{ source: string }>).filter(
      (d) => d.source === "github",
    );
    expect(fromGithub).toEqual([
      expect.objectContaining({
        version: "abcdef123456",
        service: "acme/shop",
        environment: "production",
        url: "https://app.example.com",
      }),
    ]);
  });

  it("refuses bad signatures and ignores other events and states", async () => {
    const forged = await github("deployment_status", deploymentStatus(902, "ffff"), "wrong");
    expect(forged.status).toBe(401);
    expect((await github("ping", { zen: "Keep it logically awesome." })).body).toEqual({
      outcome: "ignored",
    });
    expect(
      (await github("deployment_status", deploymentStatus(903, "eeee", "failure"))).body,
    ).toEqual({ outcome: "ignored" });
  });

  it("rotating the URL retires the old token, even when two admins rotate at once", async () => {
    const both = await Promise.all([
      post(owner, `/api/w/${ws}/deploy-hook`),
      post(owner, `/api/w/${ws}/deploy-hook`),
    ]);
    expect(both.map((r) => r.status)).toEqual([201, 201]);
    const old = hook;
    hook = (await post(owner, `/api/w/${ws}/deploy-hook`)).body;
    expect((await request(ctx.app).post(pathOf(old.url)).send({ version: "x" })).status).toBe(404);
    expect((await request(ctx.app).post(pathOf(hook.url)).send({ version: "v1.4.3" })).status).toBe(
      201,
    );
  });
});
