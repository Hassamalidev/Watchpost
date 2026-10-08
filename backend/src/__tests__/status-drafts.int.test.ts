/*
 * P5-T03 through the real API with a stand-in for the model: AI drafts of public status updates.
 * Internal host names and addresses in the team's notes never reach the model, a draft that names
 * one anyway is thrown away, and a draft is only ever text for a person to post (or, for automatic
 * incidents, what the page's own setting already allows to be published).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import type { StatusDraftView, StatusIncidentView, StatusPageView } from "@app/shared";
import { createFakeAiClient } from "../infra/anthropic/index.js";
import type { StatuspagesModule } from "../modules/statuspages/index.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  emailFromOutbox,
  signUpVerified,
} from "./helpers/container-app.js";

/* What the stand-in model answers next; tests change it. */
let answer = "We are investigating an issue with Payments. Some card payments may fail.";
const client = createFakeAiClient(() => ({ message: answer }));
const ctx = buildContainerApp({
  authRateLimit: false,
  ai: client,
  revalidate: async () => undefined,
  env: { UNFUNDED_AI_MONTHLY_CAP_USD: "10000" },
});
const run = randomBytes(4).toString("hex");
let owner: TestAgent;
let viewer: TestAgent;
let ws = "";
let page: StatusPageView;
let monitorId = "";

const api = (agent: TestAgent, method: "get" | "post" | "patch", path: string) =>
  agent[method](`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN);
const statuspages = () =>
  (ctx.container.modules.find((m) => m.name === "statuspages") as StatuspagesModule).service;
const sent = () => JSON.parse(client.requests.at(-1)?.user ?? "{}") as Record<string, unknown>;

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await ctx.container.infra.db.execute(query)).rows as T[];
}

beforeAll(async () => {
  owner = request.agent(ctx.app);
  viewer = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `draft-${run}@example.com`);
  const created = await owner
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "Drafts Co", slug: `draft-${run}` });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id as string;

  const viewerEmail = `draft-viewer-${run}@example.com`;
  await signUpVerified(ctx, viewer, viewerEmail);
  await owner
    .post("/api/auth/organization/invite-member")
    .set("Origin", WEB_ORIGIN)
    .send({ email: viewerEmail, role: "viewer", organizationId: ws });
  const { url } = await emailFromOutbox(ctx.container, viewerEmail, "invite");
  await viewer
    .post("/api/auth/organization/accept-invitation")
    .set("Origin", WEB_ORIGIN)
    .send({ invitationId: String(url).split("/").at(-1) });

  const monitor = await api(owner, "post", "/monitors").send({
    settings: { name: "Payments", regions: ["eu-central"], minFailingRegions: 1 },
    config: { type: "tcp", host: "example.com", port: 443 },
  });
  expect(monitor.status, monitor.text).toBe(201);
  monitorId = monitor.body.id as string;
  const res = await api(owner, "post", "/status-pages").send({
    name: "Acme",
    slug: `draft-${run}`,
    monitorIds: [monitorId],
  });
  expect(res.status, res.text).toBe(201);
  page = res.body as StatusPageView;
}, 120_000);

afterAll(async () => {
  await ctx.container.close();
});

describe("drafting a public update", () => {
  it("the page says drafts are available, and has a tone", () => {
    expect(page.aiDrafts).toBe(true);
    expect(page.settings.tone).toBe("neutral");
  });

  it("drafts from the team's notes, without showing the model what is internal", async () => {
    const res = await api(owner, "post", `/status-pages/${page.id}/drafts`).send({
      status: "identified",
      title: "Card payments are failing",
      impact: "major_outage",
      componentIds: [page.components[0]?.id],
      notes:
        "pg-primary-3.eu.acme.internal failed over at 10.20.30.40, writes blocked ~6 min. ask dana@acme.example. Ticket OPS-4411. token=abc123secret",
      tone: "friendly",
    });
    expect(res.status, res.text).toBe(200);
    const draft = res.body as StatusDraftView;
    expect(draft.message).toBe(answer);
    expect(draft.generationId).toMatch(/^[0-9a-f-]{36}$/);

    const evidence = sent();
    expect(evidence).toMatchObject({
      pageName: "Acme",
      incidentTitle: "Card payments are failing",
      status: "identified",
      impact: "major_outage",
      affectedServices: ["Payments"],
      tone: "friendly",
    });
    const notes = String(evidence.notes);
    for (const internal of [
      "pg-primary-3.eu.acme.internal",
      "10.20.30.40",
      "dana@acme.example",
      "abc123secret",
    ]) {
      expect(notes, internal).not.toContain(internal);
    }
    expect(notes).toContain("[internal system]");
    expect(notes).toContain("writes blocked");
    expect(client.requests.at(-1)?.schemaName).toBe("status_update");
    /* Nothing was posted: a draft is text for a person. */
    expect((await api(owner, "get", `/status-pages/${page.id}/incidents`)).body.data).toEqual([]);
  });

  it("drafts never contain internal host names or IP addresses: such a draft is thrown away", async () => {
    const body = { status: "investigating", title: "Slow checkout" };
    for (const leak of [
      "The database db-7.internal is refusing connections.",
      "Traffic to 10.0.4.12 is being dropped.",
      "We are failing over from fe80::1ff:fe23:4567:890a.",
      "See status at grafana.corp.acme.io for details.",
    ]) {
      answer = leak;
      const res = await api(owner, "post", `/status-pages/${page.id}/drafts`).send(body);
      expect(res.status, leak).toBe(409);
      expect(res.body.detail).toMatch(/named an internal system/);
      expect(JSON.stringify(res.body)).not.toContain(leak);
    }
    const refused = await rows<{ status: string; reason: string; output: unknown }>(sql`
      select status, reason, output from ai_generations
      where workspace_id = ${ws} and kind = 'status_update' and status = 'failed'`);
    expect(refused).toHaveLength(4);
    for (const row of refused) {
      expect(row).toEqual({ status: "failed", reason: "internal_detail", output: null });
    }
    answer = "We are looking into slow checkout pages. We will post an update shortly.";
    expect((await api(owner, "post", `/status-pages/${page.id}/drafts`).send(body)).status).toBe(
      200,
    );
  });

  it("uses the page's tone when none is given, and only editors may draft", async () => {
    await api(owner, "patch", `/status-pages/${page.id}`).send({
      settings: { ...page.settings, tone: "formal" },
    });
    await api(owner, "post", `/status-pages/${page.id}/drafts`).send({
      status: "resolved",
      title: "Slow checkout",
    });
    expect(sent().tone).toBe("formal");
    const denied = await api(viewer, "post", `/status-pages/${page.id}/drafts`).send({
      status: "resolved",
      title: "x",
    });
    expect(denied.status).toBe(403);
    const foreign = await api(owner, "post", `/status-pages/${page.id}/drafts`).send({
      status: "resolved",
      title: "x",
      componentIds: ["0190e2e0-0000-7000-8000-00000000ffff"],
    });
    expect(foreign.status).toBe(400);
  });

  it("an update posted from a draft is recorded as AI-drafted", async () => {
    const draft = (
      await api(owner, "post", `/status-pages/${page.id}/drafts`).send({
        status: "investigating",
        title: "Slow checkout",
      })
    ).body as StatusDraftView;
    const created = await api(owner, "post", `/status-pages/${page.id}/incidents`).send({
      title: "Slow checkout",
      message: `${draft.message} (edited by a person)`,
      aiGenerationId: draft.generationId,
    });
    expect(created.status, created.text).toBe(201);
    const incident = created.body as StatusIncidentView;
    await api(owner, "post", `/status-pages/${page.id}/incidents/${incident.id}/updates`).send({
      status: "resolved",
      message: "Written by hand.",
    });
    const updates = await rows<{ body: string; ai_drafted: boolean }>(sql`
      select body, ai_drafted from status_updates
      where status_incident_id = ${incident.id} order by created_at`);
    expect(updates.map((u) => u.ai_drafted)).toEqual([true, false]);
  });
});

describe("automatic incidents", () => {
  it("are written by the model when it answers, and by the fixed text when it doesn't", async () => {
    await api(owner, "patch", `/status-pages/${page.id}`).send({
      settings: {
        ...page.settings,
        autoIncidents: { enabled: true, afterMinutes: 1, publish: "auto" },
      },
    });
    const down = () =>
      ctx.container.infra.db.execute(sql`
        insert into monitor_state (monitor_id, workspace_id, status, since, last_result_at)
        values (${monitorId}, ${ws}, 'down', now() - interval '5 minutes', now())
        on conflict (monitor_id) do update set status = 'down', since = now() - interval '5 minutes'`);
    const up = () =>
      ctx.container.infra.db.execute(
        sql`update monitor_state set status = 'up', since = now() where monitor_id = ${monitorId}`,
      );
    const autos = async () =>
      (
        (await api(owner, "get", `/status-pages/${page.id}/incidents`)).body
          .data as StatusIncidentView[]
      ).filter((i) => i.auto);

    answer = "Payments is currently unavailable. We are investigating and will share more soon.";
    await down();
    expect(await statuspages().autoIncidents()).toEqual({ opened: 1, resolved: 0 });
    expect(sent()).toMatchObject({ affectedServices: ["Payments"], status: "investigating" });
    expect(JSON.stringify(sent())).not.toContain("example.com");
    let [incident] = await autos();
    expect(incident?.updates[0]?.message).toBe(answer);

    /* The model leaks on the way back up: the fixed text is used instead, and the page is fine. */
    answer = "Recovered after restarting pg-primary-3.eu.acme.internal.";
    await up();
    expect(await statuspages().autoIncidents(monitorId)).toEqual({ opened: 0, resolved: 1 });
    [incident] = await autos();
    expect(incident?.updates[0]?.message).toBe("Payments is responding normally again.");
    const flags = await rows<{ ai_drafted: boolean }>(sql`
      select ai_drafted from status_updates
      where status_incident_id = ${incident?.id} order by created_at`);
    expect(flags.map((f) => f.ai_drafted)).toEqual([true, false]);
  }, 60_000);
});
