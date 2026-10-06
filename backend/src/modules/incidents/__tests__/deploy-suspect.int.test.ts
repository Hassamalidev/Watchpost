/*
 * P1-T26: a deploy shortly before an incident shows in the monitor's "what changed" timeline and leads
 * the incident explanation (the same explanation alerts carry).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import type { IncidentsModule } from "../index.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  signUpVerified,
} from "../../../__tests__/helpers/container-app.js";

let ctx: ReturnType<typeof buildContainerApp>;
let owner: TestAgent;
let ws: string;
let hookPath: string;

const post = (agent: TestAgent, path: string, body: object = {}) =>
  agent.post(path).set("Origin", WEB_ORIGIN).send(body);
const get = (agent: TestAgent, path: string) => agent.get(path).set("Origin", WEB_ORIGIN);

beforeAll(async () => {
  ctx = buildContainerApp();
  owner = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `suspect-${randomBytes(4).toString("hex")}@example.com`);
  const created = await post(owner, "/api/auth/organization/create", {
    name: "Suspect Co",
    slug: `suspect-co-${randomBytes(4).toString("hex")}`,
  });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id;
  const hook = await post(owner, `/api/w/${ws}/deploy-hook`);
  hookPath = new URL(hook.body.url as string).pathname;
});

afterAll(async () => {
  await ctx.container.close();
});

describe("deploys in incidents", () => {
  it("appear in what changed and lead the incident explanation", async () => {
    const monitor = await post(owner, `/api/w/${ws}/monitors`, {
      settings: { name: "Shop", regions: ["eu-central"] },
      config: { type: "http", url: "https://shop.example.com" },
    });
    expect(monitor.status, monitor.text).toBe(201);
    await request(ctx.app)
      .post(hookPath)
      .send({ version: "9f8e7d6", environment: "production", description: "Checkout rewrite" });

    const changes = await get(owner, `/api/w/${ws}/monitors/${monitor.body.id}/changes`);
    expect(changes.body.data).toContainEqual(
      expect.objectContaining({
        kind: "deploy",
        title: "Deployed 9f8e7d6 to production",
        detail: "Checkout rewrite",
      }),
    );

    const incidents = ctx.container.modules.find((m) => m.name === "incidents") as IncidentsModule;
    const { incident } = await ctx.container.infra.db.transaction((tx) =>
      incidents.service.openForMonitor(tx, {
        workspaceId: ws,
        monitorId: monitor.body.id,
        title: "Shop is down",
        severity: "high",
        causeCode: "http_status_unexpected",
        failingRegions: ["eu-central"],
        evidence: { httpStatus: 500 },
      }),
    );
    const detail = await get(owner, `/api/w/${ws}/incidents/${incident.id}`);
    expect(detail.body.recentDeploy).toMatchObject({
      version: "9f8e7d6",
      environment: "production",
      minutesBefore: 0,
    });
    expect(detail.body.explanation.nextSteps[0]).toBe(
      "Deploy 9f8e7d6 to production went out less than a minute before this started; roll it back if the timing fits.",
    );
  });
});
