/*
 * P6-T07 through the real app: an admin adds a private probe and gets its token and install command
 * once; the probe connects with that token and becomes a check location of its own; monitors run on
 * it and nowhere else; the workspace is told once when it goes silent; the plan decides how many
 * there may be.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { v7 as uuidv7 } from "uuid";
import {
  PROBE_CURRENT_VERSION,
  parseProbeToken,
  type CreatedPrivateProbe,
  type PrivateProbeView,
} from "@app/shared";
import { createFakeClock } from "../core/clock.js";
import type { ProbesModule } from "../modules/probes/index.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  countResults,
  probeClient,
  signUpVerified,
} from "./helpers/container-app.js";

const MINUTE = 60_000;
const DAY = 86_400_000;
const clock = createFakeClock(new Date());
const ctx = buildContainerApp({
  authRateLimit: false,
  clock,
  env: { PRIVATE_PROBE_IMAGE: "registry.example.com/probe:1.2.3" },
});
const run = randomBytes(4).toString("hex");
const ownerEmail = `pp-${run}@example.com`;
let owner: TestAgent;
let other: TestAgent;
let ws = "";
let otherWs = "";
let made: CreatedPrivateProbe;
let client: ReturnType<typeof probeClient>;
let monitorId = "";

const api = (agent: TestAgent, wsId: string, method: "get" | "post" | "delete", path: string) =>
  agent[method](`/api/w/${wsId}${path}`).set("Origin", WEB_ORIGIN);
const probes = () => ctx.container.modules.find((m) => m.name === "probes") as ProbesModule;
const list = async () =>
  (await api(owner, ws, "get", "/private-probes")).body.data as PrivateProbeView[];
const hello = (version: string, region = made.region) =>
  client.call("POST", "/hello", {
    version,
    mode: "private",
    region,
    capabilities: ["http", "tcp"],
  });
const monitor = (agent: TestAgent, wsId: string, name: string, regions: string[]) =>
  api(agent, wsId, "post", "/monitors").send({
    settings: { name, regions },
    config: { type: "tcp", host: "10.0.0.12", port: 5432 },
  });
const offlineEmails = async () =>
  (
    await ctx.container.infra.db.execute<{
      payload: { to: string; data: Record<string, unknown> };
    }>(
      sql`select payload from outbox_events where type = 'email.requested' and workspace_id = ${ws} and payload->>'template' = 'probe-offline' order by created_at`,
    )
  ).rows.map((r) => r.payload);

async function workspace(agent: TestAgent, email: string, label: string): Promise<string> {
  await signUpVerified(ctx, agent, email);
  const created = await agent
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: `${label} Co`, slug: `${label}-${run}` });
  expect(created.status, created.text).toBe(200);
  return created.body.id as string;
}

beforeAll(async () => {
  owner = request.agent(ctx.app);
  other = request.agent(ctx.app);
  ws = await workspace(owner, ownerEmail, "pp");
  otherWs = await workspace(other, `pp-other-${run}@example.com`, "pp-other");
}, 120_000);

afterAll(async () => {
  await ctx.container.close();
});

describe("private probes", () => {
  it("adding one answers with its token and the install command, once", async () => {
    const res = await api(owner, ws, "post", "/private-probes").send({ name: "Office rack" });
    expect(res.status, res.text).toBe(201);
    made = res.body as CreatedPrivateProbe;
    expect(made.region).toBe(`private:${made.id}`);
    expect(made).toMatchObject({
      name: "Office rack",
      online: false,
      lastSeenAt: null,
      version: null,
      upgradeAvailable: false,
      monitors: 0,
    });
    const parsed = parseProbeToken(made.token);
    expect(parsed?.probeId).toBe(made.id);
    expect(made.command).toBe(
      `docker run -d --name monitoring-probe --restart unless-stopped --cap-drop ALL --cap-add NET_RAW -v monitoring-probe:/var/lib/watchpost-probe -e API_URL=${WEB_ORIGIN} -e PROBE_TOKEN=${made.token} registry.example.com/probe:1.2.3`,
    );
    /* Listed without the token, and stored encrypted. */
    const listed = await api(owner, ws, "get", "/private-probes");
    expect(JSON.stringify(listed.body)).not.toContain(parsed?.secret ?? "?");
    const stored = await ctx.container.infra.db.execute<{ secret_enc: string }>(
      sql`select secret_enc from probes where id = ${made.id}`,
    );
    expect(stored.rows[0]?.secret_enc).not.toContain(parsed?.secret ?? "?");
    client = probeClient(ctx.app, { id: made.id, secret: parsed?.secret ?? "" });

    /* The Pro trial includes one. */
    const second = await api(owner, ws, "post", "/private-probes").send({ name: "Second" });
    expect(second.status).toBe(402);
    expect(second.body.detail).toContain("includes 1 private probe");
    expect((await api(owner, ws, "post", "/private-probes").send({ name: "" })).status).toBe(400);
  });

  it("the probe connects with its token, shows as online, and is offered an upgrade when old", async () => {
    /* It can't claim to be one of our regions, or another probe's location. */
    expect((await hello("0.0.9", "eu-central")).status).toBe(400);
    const res = await hello("0.0.9");
    expect(res.status, res.text).toBe(200);
    expect(res.body.probeId).toBe(made.id);
    expect((await list())[0]).toMatchObject({
      online: true,
      version: "0.0.9",
      upgradeAvailable: true,
    });
    await hello(PROBE_CURRENT_VERSION);
    expect((await list())[0]).toMatchObject({
      version: PROBE_CURRENT_VERSION,
      upgradeAvailable: false,
    });
  });

  it("a monitor runs on the private probe only, and only in its own workspace", async () => {
    const created = await monitor(owner, ws, "Internal database", [made.region]);
    expect(created.status, created.text).toBe(201);
    monitorId = created.body.id as string;
    expect(created.body.regions).toEqual([made.region]);
    await monitor(owner, ws, "Public site", ["eu-central"]);

    /* Not mixed with our regions, not on a probe that doesn't exist, not on someone else's. */
    expect((await monitor(owner, ws, "Mixed", [made.region, "eu-central"])).status).toBe(400);
    expect((await monitor(owner, ws, "Nowhere", [`private:${uuidv7()}`])).status).toBe(400);
    const foreign = await monitor(other, otherWs, "Theirs", [made.region]);
    expect(foreign.status).toBe(400);
    expect(foreign.body.detail).toContain("doesn't exist in this workspace");

    const assigned = await client.call("GET", "/assignments?full=true");
    expect(assigned.status, assigned.text).toBe(200);
    expect(assigned.body.upserts.map((m: { id: string }) => m.id)).toEqual([monitorId]);
    expect((await list())[0]?.monitors).toBe(1);

    /* Its results are stored under its own location. */
    const result = {
      id: uuidv7(),
      monitorId,
      region: made.region,
      checkedAt: new Date().toISOString(),
      ok: true,
      latencyMs: 3,
    };
    const sent = await client.call("POST", "/results", { batchId: uuidv7(), results: [result] });
    expect(sent.status, sent.text).toBe(202);
    expect(sent.body).toEqual({ accepted: 1, duplicates: 0 });
    expect(await countResults(ctx.container, [result.id])).toBe(1);
    const checks = await api(
      owner,
      ws,
      "get",
      `/monitors/${monitorId}/checks?region=${made.region}`,
    );
    expect(checks.status, checks.text).toBe(200);
    expect(checks.body.data[0]).toMatchObject({ region: made.region, ok: true });
  });

  it("tells the owner once when the probe goes silent, and again after it came back", async () => {
    expect(await probes().privateProbes.notifyOffline()).toBe(0);
    clock.advance(6 * MINUTE);
    expect((await list())[0]?.online).toBe(false);
    expect(await probes().privateProbes.notifyOffline()).toBe(1);
    const [email, ...rest] = await offlineEmails();
    expect(rest).toEqual([]);
    expect(email?.to).toBe(ownerEmail);
    expect(email?.data).toMatchObject({
      workspaceName: "pp Co",
      probeName: "Office rack",
      monitors: 1,
      url: `${WEB_ORIGIN}/w/${ws}/settings`,
    });
    clock.advance(30 * MINUTE);
    expect(await probes().privateProbes.notifyOffline()).toBe(0);
    expect(await offlineEmails()).toHaveLength(1);

    /* It reports again, then goes silent again: that is a new outage of the probe. */
    await hello(PROBE_CURRENT_VERSION);
    clock.advance(6 * MINUTE);
    expect(await probes().privateProbes.notifyOffline()).toBe(1);
    expect(await offlineEmails()).toHaveLength(2);
    clock.advance(-42 * MINUTE);
  });

  it("can't be removed while monitors run on it; removing it locks the probe out", async () => {
    const refused = await api(owner, ws, "delete", `/private-probes/${made.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.detail).toContain("1 monitor runs on this probe");
    expect((await api(other, otherWs, "delete", `/private-probes/${made.id}`)).status).toBe(404);

    await api(owner, ws, "delete", `/monitors/${monitorId}`);
    expect((await api(owner, ws, "delete", `/private-probes/${made.id}`)).status).toBe(204);
    expect(await list()).toEqual([]);
    expect((await client.call("GET", "/assignments")).status).toBe(401);
  });

  it("the Free plan has none", async () => {
    clock.advance(20 * DAY);
    try {
      const refused = await api(owner, ws, "post", "/private-probes").send({ name: "On Free" });
      expect(refused.status).toBe(402);
      expect(refused.body.detail).toContain("Pro and Business plans");
    } finally {
      clock.advance(-20 * DAY);
    }
  });
});
