/*
 * P1-T18 AC, "action links are single-use and expire", through the real API: preview never changes
 * anything, the first POST acts (as the member the link was sent to, marked "via email"), a second
 * use is refused, expired links answer 410 and forged ones 404. The alert email carries per-recipient
 * links.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { createFakeClock } from "../../../core/clock.js";
import { createActionLinks } from "../../../infra/action-links.js";
import type { IncidentsModule } from "../../incidents/index.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  signUpVerified,
} from "../../../__tests__/helpers/container-app.js";

let ctx: ReturnType<typeof buildContainerApp>;
let owner: TestAgent;
let ownerEmail: string;
let ws: string;
let incidents: IncidentsModule;

const tokenOf = (url: string) => url.split("/a/")[1] ?? "";
const api = () => request(ctx.app);

async function openIncident(name: string) {
  const monitor = await owner
    .post(`/api/w/${ws}/monitors`)
    .set("Origin", WEB_ORIGIN)
    .send({ settings: { name }, config: { type: "tcp", host: "example.com", port: 443 } });
  expect(monitor.status, monitor.text).toBe(201);
  const { incident } = await ctx.container.infra.db.transaction((tx) =>
    incidents.service.openForMonitor(tx, {
      workspaceId: ws,
      monitorId: monitor.body.id,
      title: `${name} is down`,
      severity: "high",
      causeCode: "connect_refused",
      failingRegions: ["eu-central"],
    }),
  );
  return incident;
}

beforeAll(async () => {
  ctx = buildContainerApp();
  owner = request.agent(ctx.app);
  ownerEmail = `act-owner-${randomBytes(4).toString("hex")}@example.com`;
  await signUpVerified(ctx, owner, ownerEmail);
  const created = await owner
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "Actions Co", slug: `actions-co-${randomBytes(4).toString("hex")}` });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id;
  incidents = ctx.container.modules.find((m) => m.name === "incidents") as IncidentsModule;
});

afterAll(async () => {
  await ctx.container.close();
});

describe("action links", () => {
  it("previews without acting, acknowledges once as the recipient, and refuses reuse", async () => {
    const incident = await openIncident("Checkout");
    const token = tokenOf(
      ctx.container.infra.actionLinks.url({
        workspaceId: ws,
        incidentId: incident.id,
        action: "acknowledge",
        recipient: ownerEmail,
      }),
    );

    const preview = await api().get(`/api/actions/${token}`);
    expect(preview.status, preview.text).toBe(200);
    expect(preview.body).toMatchObject({
      action: "acknowledge",
      recipient: ownerEmail,
      used: false,
      incident: { number: incident.number, status: "triggered" },
    });
    await api().get(`/api/actions/${token}`);

    const done = await api().post(`/api/actions/${token}`);
    expect(done.status, done.text).toBe(200);
    expect(done.body).toMatchObject({ result: "done", incident: { status: "acknowledged" } });

    const again = await api().post(`/api/actions/${token}`);
    expect(again.status).toBe(409);
    expect((await api().get(`/api/actions/${token}`)).body.used).toBe(true);

    const [event] = (
      await ctx.container.infra.db.execute<{ actor: string; data: { via: string } }>(
        sql`select actor, data from incident_events where incident_id = ${incident.id} and type = 'acknowledged'`,
      )
    ).rows;
    expect(event?.data.via).toBe("email");
    const me = await owner.get(`/api/w/${ws}/me`).set("Origin", WEB_ORIGIN);
    expect(event?.actor).toBe(me.body.userId);
  });

  it("resolves with a resolve link, and says so when there's nothing left to do", async () => {
    const incident = await openIncident("Search");
    const link = (action: "acknowledge" | "resolve") =>
      tokenOf(
        ctx.container.infra.actionLinks.url({
          workspaceId: ws,
          incidentId: incident.id,
          action,
          recipient: "oncall@example.com",
        }),
      );
    const resolved = await api().post(`/api/actions/${link("resolve")}`);
    expect(resolved.body).toMatchObject({ result: "done", incident: { status: "resolved" } });
    const late = await api().post(`/api/actions/${link("acknowledge")}`);
    expect(late.body).toMatchObject({ result: "already", incident: { status: "resolved" } });
  });

  it("answers 410 for expired links and 404 for forged ones", async () => {
    const incident = await openIncident("Billing");
    const clock = createFakeClock(new Date(Date.now() - 25 * 3_600_000));
    const old = createActionLinks({
      secret: ctx.config.auth.secret,
      webOrigin: WEB_ORIGIN,
      clock,
    }).url({
      workspaceId: ws,
      incidentId: incident.id,
      action: "acknowledge",
      recipient: ownerEmail,
    });
    expect((await api().get(`/api/actions/${tokenOf(old)}`)).status).toBe(410);
    expect((await api().post(`/api/actions/${tokenOf(old)}`)).status).toBe(410);

    const forged = createActionLinks({
      secret: "x".repeat(40),
      webOrigin: WEB_ORIGIN,
      clock: createFakeClock(new Date()),
    }).url({ workspaceId: ws, incidentId: incident.id, action: "resolve", recipient: ownerEmail });
    expect((await api().post(`/api/actions/${tokenOf(forged)}`)).status).toBe(404);
    const [row] = (
      await ctx.container.infra.db.execute<{ status: string }>(
        sql`select status from incidents where id = ${incident.id}`,
      )
    ).rows;
    expect(row?.status).toBe("triggered");
  });
});
