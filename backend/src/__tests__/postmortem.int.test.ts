/*
 * P5-T04 through the real API with a stand-in for the model: a postmortem is drafted from the
 * incident's own record, saved for a person to edit, and exported as Markdown and as a PDF. A draft
 * for an incident with 50 timeline events is ready in well under 20 seconds.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import type { AiPostmortem, PostmortemView } from "@app/shared";
import { createFakeAiClient } from "../infra/anthropic/index.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  emailFromOutbox,
  signUpVerified,
} from "./helpers/container-app.js";

const MODEL_MS = 2_000;
const DRAFT: AiPostmortem = {
  summary: "Checkout was unavailable until the team resolved it.",
  impact: "Customers could not complete purchases while the incident was open.",
  rootCause: "The record does not establish the root cause; it is still to be confirmed.",
  whatWentWell: ["The incident was acknowledged quickly."],
  whatWentWrong: ["Several comments were needed before the cause was narrowed down."],
  actionItems: ["Add a health check for the payment provider.", "Review the on-call runbook."],
};
/* The stand-in thinks for two seconds, like a model writing a long answer. */
const client = createFakeAiClient(
  () => new Promise((resolve) => setTimeout(() => resolve(DRAFT), MODEL_MS)),
);
const ctx = buildContainerApp({
  authRateLimit: false,
  ai: client,
  env: { UNFUNDED_AI_MONTHLY_CAP_USD: "10000" },
});
const run = randomBytes(4).toString("hex");
let owner: TestAgent;
let viewer: TestAgent;
let ws = "";
let incident = { id: "", number: 0 };

const api = (agent: TestAgent, method: "get" | "post" | "put", path: string) =>
  agent[method](`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN);

beforeAll(async () => {
  owner = request.agent(ctx.app);
  viewer = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `pm-${run}@example.com`);
  const created = await owner
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "Postmortem Co", slug: `pm-${run}` });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id as string;

  const viewerEmail = `pm-viewer-${run}@example.com`;
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

  /* An incident with a 50-event timeline: opened, acknowledged, 47 comments, resolved. */
  const opened = await api(owner, "post", "/incidents").send({
    title: "Checkout is down",
    severity: "critical",
  });
  expect(opened.status, opened.text).toBe(201);
  incident = { id: opened.body.id as string, number: opened.body.number as number };
  await api(owner, "post", `/incidents/${incident.number}/acknowledge`).send({});
  for (let i = 1; i <= 47; i += 1) {
    const note =
      i === 5
        ? "Contact sara@acme.example, the token is Bearer abc123def456ghi"
        : `Checked system ${i}: nothing unusual.`;
    const res = await api(owner, "post", `/incidents/${incident.number}/comments`).send({
      body: note,
    });
    expect(res.status, res.text).toBe(201);
  }
  await api(owner, "post", `/incidents/${incident.number}/resolve`).send({});
  const detail = await api(owner, "get", `/incidents/${incident.number}`);
  expect((detail.body.timeline as unknown[]).length).toBe(50);
}, 180_000);

afterAll(async () => {
  await ctx.container.close();
});

describe("postmortems", () => {
  it("an incident starts without one", async () => {
    expect((await api(owner, "get", `/incidents/${incident.number}/postmortem`)).body).toEqual({
      data: null,
    });
    expect((await api(owner, "get", `/incidents/${incident.number}/postmortem.md`)).status).toBe(
      404,
    );
  });

  it("a draft for a 50-event incident is ready in under 20 s, from the record", async () => {
    const started = performance.now();
    const res = await api(owner, "post", `/incidents/${incident.number}/postmortem/draft`).send({});
    const elapsedMs = performance.now() - started;
    expect(res.status, res.text).toBe(200);
    process.stdout.write(
      `postmortem draft for 50 events: ${Math.round(elapsedMs)} ms in all, ${Math.round(elapsedMs - MODEL_MS)} ms of it ours (the stand-in model takes ${MODEL_MS} ms)\n`,
    );
    expect(elapsedMs).toBeLessThan(20_000);
    /* Our own share is small: the time is the model's. */
    expect(elapsedMs - MODEL_MS).toBeLessThan(3_000);

    const view = res.body as PostmortemView;
    expect(view.aiDrafted).toBe(true);
    const md = view.markdown;
    expect(md).toContain(`# Postmortem: Checkout is down (#${incident.number})`);
    expect(md).toContain("_Drafted by AI from the incident record.");
    expect(md).toContain(DRAFT.summary);
    expect(md).toContain("- Add a health check for the payment provider.");
    /* Facts and the timeline come from the record, with every event in order. */
    expect(md).toContain("- Severity: critical");
    expect(md).toMatch(
      /- Acknowledged: \d{4}-\d\d-\d\d \d\d:\d\d UTC \(\d+ min after it started\)/,
    );
    expect(md).toMatch(/- Resolved: .* UTC \(\d+ min after it started\)/);
    const timeline = md.slice(md.indexOf("## Timeline"), md.indexOf("## What went well"));
    expect(timeline.match(/^- /gm)).toHaveLength(50);
    expect(timeline).toContain("— Incident opened");
    expect(timeline).toContain("— Acknowledged by a team member");
    expect(timeline).toContain(
      "— Comment added by a team member: Checked system 47: nothing unusual.",
    );

    /* What the model was shown had no address or credential, and nobody's name or ID. */
    const sent = client.requests.at(-1)?.user ?? "";
    expect(sent).not.toContain("sara@acme.example");
    expect(sent).not.toContain("abc123def456ghi");
    expect(sent).toContain("[email]");
    expect(client.requests.at(-1)?.timeoutMs).toBe(18_000);
    const [me] = (
      await ctx.container.infra.db.execute<{ id: string }>(
        sql`select id from "user" where email = ${`pm-${run}@example.com`}`,
      )
    ).rows;
    expect(sent).not.toContain(me?.id ?? "no-user");
  }, 60_000);

  it("is edited and saved by people, and stays marked as started by AI", async () => {
    const edited =
      "# Postmortem\n\n## Summary\nRewritten by a person.\n\n## Action items\n- Fix it\n";
    const saved = await api(owner, "put", `/incidents/${incident.number}/postmortem`).send({
      markdown: edited,
    });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.body).toMatchObject({ markdown: edited, aiDrafted: true });
    expect((await api(owner, "get", `/incidents/${incident.number}/postmortem`)).body.data).toEqual(
      saved.body,
    );
    const detail = await api(owner, "get", `/incidents/${incident.number}`);
    expect(
      (detail.body.timeline as Array<{ type: string }>).filter(
        (e) => e.type === "postmortem_started",
      ),
    ).toHaveLength(1);
    expect(
      (
        await api(owner, "put", `/incidents/${incident.number}/postmortem`).send({
          markdown: "x".repeat(50_001),
        })
      ).status,
    ).toBe(400);
  });

  it("exports as Markdown and as a PDF", async () => {
    const md = await api(owner, "get", `/incidents/${incident.number}/postmortem.md`);
    expect(md.status).toBe(200);
    expect(md.headers["content-type"]).toMatch(/text\/markdown/);
    expect(md.headers["content-disposition"]).toBe(
      `attachment; filename="postmortem-${incident.number}.md"`,
    );
    expect(md.text).toContain("Rewritten by a person.");

    const pdf = await api(owner, "get", `/incidents/${incident.number}/postmortem.pdf`)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toMatch(/application\/pdf/);
    expect((pdf.body as Buffer).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect((pdf.body as Buffer).length).toBeGreaterThan(1_000);
  }, 60_000);

  it("viewers read and export; they can't draft or edit", async () => {
    expect((await api(viewer, "get", `/incidents/${incident.number}/postmortem`)).status).toBe(200);
    expect((await api(viewer, "get", `/incidents/${incident.number}/postmortem.md`)).status).toBe(
      200,
    );
    expect(
      (await api(viewer, "put", `/incidents/${incident.number}/postmortem`).send({ markdown: "x" }))
        .status,
    ).toBe(403);
    expect(
      (await api(viewer, "post", `/incidents/${incident.number}/postmortem/draft`).send({})).status,
    ).toBe(403);
  });

  it("a postmortem written from nothing is not marked as AI", async () => {
    const other = await api(owner, "post", "/incidents").send({ title: "Small blip" });
    const saved = await api(owner, "put", `/incidents/${other.body.number}/postmortem`).send({
      markdown: "# Small blip\nNothing to learn.",
    });
    expect(saved.body.aiDrafted).toBe(false);
  });
});
