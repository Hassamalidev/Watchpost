/*
 * P5-T02 against the real container with a stand-in for the model that takes 1.5 s to answer: the
 * alert for a new incident goes out while the explainer is still thinking, the explanation lands on
 * the incident afterwards, and the time to the first alert is the same with AI on and off.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { createFakeAiClient } from "../infra/anthropic/index.js";
import type { AiModule } from "../modules/ai/index.js";
import { EXPLAINER_CASES } from "../modules/ai/evals/fixtures.js";
import type { AlertingModule } from "../modules/alerting/index.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  signUpVerified,
  stubHttp,
} from "./helpers/container-app.js";

const AI_DELAY_MS = 1_500;
const ANSWER = EXPLAINER_CASES[0]?.answer;
const client = createFakeAiClient(
  () => new Promise((resolve) => setTimeout(() => resolve(ANSWER), AI_DELAY_MS)),
);
const http = stubHttp();
const ctx = buildContainerApp({
  authRateLimit: false,
  http,
  ai: client,
  env: { UNFUNDED_AI_MONTHLY_CAP_USD: "10000" },
});
const run = randomBytes(4).toString("hex");
let owner: TestAgent;
let ws = "";

const find = <T>(name: string) => ctx.container.modules.find((m) => m.name === name) as T;
const ai = () => find<AiModule>("ai").service;
const alerting = () => find<AlertingModule>("alerting").service;
const api = (method: "get" | "post" | "put", path: string) =>
  owner[method](`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN);
const hooks = () => http.requests.filter((r) => r.url === "https://hooks.example.com/ai");

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await ctx.container.infra.db.execute(query)).rows as T[];
}

/* Opens an incident by hand and returns it with the event the worker would get. */
async function openIncident(title: string) {
  const created = await api("post", "/incidents").send({ title, severity: "high" });
  expect(created.status, created.text).toBe(201);
  const id = created.body.id as string;
  const [event] = await rows<{ id: string }>(sql`
    select id from outbox_events
    where type = 'incident.triggered' and payload->>'incidentId' = ${id}`);
  return { id, number: created.body.number as number, eventId: event?.id ?? "" };
}

/* What alerting's handler does with the event: plan the alert and send it. Returns the time taken. */
async function alert(incident: { id: string; eventId: string }): Promise<number> {
  const started = performance.now();
  const planned = await alerting().planIncidentEvent({
    kind: "triggered",
    incidentId: incident.id,
    eventKey: incident.eventId,
  });
  expect(planned).toBe(1);
  const [delivery] = await rows<{ id: string }>(sql`
    select id from notification_deliveries where incident_id = ${incident.id}`);
  expect(await alerting().deliver(delivery?.id ?? "")).toBe("sent");
  return performance.now() - started;
}

beforeAll(async () => {
  owner = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `aix-${run}@example.com`);
  const created = await owner
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "Explainer Co", slug: `aix-${run}` });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id as string;
  const channel = await api("post", "/channels").send({
    type: "webhook",
    name: "AI hook",
    config: { url: "https://hooks.example.com/ai" },
  });
  expect(channel.status, channel.text).toBe(201);
  const routed = await api("put", `/alert-policies/default/channels/${channel.body.id}`).send({});
  expect(routed.status, routed.text).toBe(200);
}, 120_000);

afterAll(async () => {
  await ctx.container.close();
});

describe("the incident explainer", () => {
  it("the first alert is out while the model is still thinking; the summary follows", async () => {
    const incident = await openIncident("Checkout API is down");

    /* Both handlers get the same event; neither waits for the other. */
    let explained: string | undefined;
    const explaining = ai()
      .explainIncident(incident.id)
      .then((outcome) => {
        explained = outcome;
        return outcome;
      });
    const alertMs = await alert(incident);
    expect(hooks()).toHaveLength(1);
    expect(explained, "the model had not answered when the alert was sent").toBeUndefined();
    expect(alertMs).toBeLessThan(AI_DELAY_MS);

    /* Until it answers, the incident simply has no summary. */
    const before = await api("get", `/incidents/${incident.number}`);
    expect(before.body.aiSummary).toBeNull();

    expect(await explaining).toBe("explained");
    const after = await api("get", `/incidents/${incident.number}`);
    expect(after.body.aiSummary).toMatchObject({
      headline: ANSWER?.headline,
      confidence: "medium",
      model: "fake-model",
    });
    expect((after.body.timeline as Array<{ type: string }>).map((e) => e.type)).toContain(
      "ai_summary",
    );
    const ready = await rows<{ payload: { generationId: string } }>(sql`
      select payload from outbox_events
      where type = 'incident.ai_summary_ready' and payload->>'incidentId' = ${incident.id}`);
    expect(ready).toHaveLength(1);
    expect(ready[0]?.payload.generationId).toBe(after.body.aiSummary.generationId);

    /* A webhook has no thread to reply in; the summary is on the incident and nothing is re-sent. */
    expect(await alerting().postAiSummary(incident.id)).toBe(0);
    expect(hooks()).toHaveLength(1);

    /* The same event again explains nothing twice. */
    expect(await ai().explainIncident(incident.id)).toBe("already");
    expect(client.requests).toHaveLength(1);
  }, 60_000);

  it("first-alert latency is the same with the explainer running and without it", async () => {
    const samples = { on: [] as number[], off: [] as number[] };
    for (let i = 0; i < 4; i += 1) {
      const withAi = await openIncident(`With AI ${i}`);
      const pending = ai().explainIncident(withAi.id);
      samples.on.push(await alert(withAi));
      const withoutAi = await openIncident(`Without AI ${i}`);
      samples.off.push(await alert(withoutAi));
      await pending;
    }
    const median = (values: number[]) =>
      [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
    const on = median(samples.on);
    const off = median(samples.off);
    process.stdout.write(
      `first alert (plan + send, ms): median ${on.toFixed(0)} with the explainer running, ${off.toFixed(0)} without\n`,
    );
    /* Unchanged: nowhere near the model's 1.5 s, and within noise of the run without it. */
    expect(on).toBeLessThan(AI_DELAY_MS / 2);
    expect(Math.abs(on - off)).toBeLessThan(250);
  }, 120_000);
});
