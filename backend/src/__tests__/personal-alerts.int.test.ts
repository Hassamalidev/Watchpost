/*
 * P4-T02b against the real container with a fake clock: an incident reaches a person through their
 * own contact methods at the delays their rules set, a delayed step is dropped once someone has
 * acknowledged, and planning twice sends once (PRODUCT.md §9.5).
 */
import { randomBytes } from "node:crypto";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContactMethodView } from "@app/shared";
import { createFakeClock } from "../core/clock.js";
import { buildJobId } from "../infra/queues/index.js";
import type { AlertingModule } from "../modules/alerting/index.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  emailFromOutbox,
  signUpVerified,
} from "./helpers/container-app.js";

const clock = createFakeClock(new Date());
const ctx = buildContainerApp({ authRateLimit: false, clock });
const run = randomBytes(4).toString("hex");
const accountEmail = `personal-owner-${run}@example.com`;
const secondEmail = `personal-second-${run}@example.com`;
const MINUTE = 60_000;

let owner: TestAgent;
let ws = "";
let userId = "";

const alerting = () =>
  (ctx.container.modules.find((m) => m.name === "alerting") as AlertingModule).service;
const api = (method: "get" | "post" | "put", path: string) =>
  owner[method](`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN);

async function openIncident(title: string): Promise<{ id: string; number: number }> {
  const created = await api("post", "/incidents").send({ title, severity: "critical" });
  expect(created.status, created.text).toBe(201);
  return { id: created.body.id as string, number: created.body.number as number };
}

async function alertEmailTitles(to: string): Promise<string[]> {
  const rows = await ctx.container.infra.pool.query<{ title: string }>(
    `select payload->'data'->'incident'->>'title' as title from outbox_events
     where type = 'email.requested' and payload->>'to' = $1 and payload->>'template' = 'alert'`,
    [to],
  );
  return rows.rows.map((r) => r.title);
}

beforeAll(async () => {
  owner = request.agent(ctx.app);
  await signUpVerified(ctx, owner, accountEmail);
  const created = await owner
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "Personal", slug: `personal-${run}` });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id as string;
  const members = await api("get", "/members");
  userId = (members.body.data as { userId: string }[])[0]?.userId ?? "";

  /* A second address, tried seven minutes after the account email. */
  const added = await api("post", "/me/contact-methods").send({
    type: "email",
    address: secondEmail,
  });
  expect(added.status, added.text).toBe(201);
  const code = String((await emailFromOutbox(ctx.container, secondEmail, "contact-code")).code);
  const confirmed = await api("post", `/me/contact-methods/${added.body.id}/confirm`).send({
    code,
  });
  expect(confirmed.status, confirmed.text).toBe(200);
  const methods = (await api("get", "/me/contact-methods")).body.data as ContactMethodView[];
  const account = methods.find((m) => m.address === accountEmail);
  const rules = await api("put", "/me/notification-rules/high").send({
    rules: [
      { contactMethodId: account?.id, delayMinutes: 0 },
      { contactMethodId: added.body.id, delayMinutes: 7 },
    ],
  });
  expect(rules.status, rules.text).toBe(200);
}, 120_000);

afterAll(async () => {
  await ctx.container.close();
});

describe("an incident sent to a person", () => {
  it("goes to each contact method at the delay its rule sets, once", async () => {
    const incident = await openIncident(`Checkout down ${run}`);
    const start = clock.now().getTime();
    const planned = await alerting().notifyUser({
      incidentId: incident.id,
      eventKey: `page.${incident.id}`,
      userId,
    });
    expect(planned).toBe(2);
    /* Planning the same event again adds nothing. */
    expect(
      await alerting().notifyUser({
        incidentId: incident.id,
        eventKey: `page.${incident.id}`,
        userId,
      }),
    ).toBe(0);

    const personal = (await alerting().deliveriesFor(incident.id)).filter((d) => d.userId !== null);
    const now = personal.find((d) => d.dueAt === null);
    const later = personal.find((d) => d.dueAt !== null);
    expect(personal).toHaveLength(2);
    expect(now?.contactType).toBe("email");
    expect(Date.parse(later?.dueAt ?? "")).toBe(start + 7 * MINUTE);

    /* The delayed step waits in the queue for its seven minutes. */
    const queue = ctx.container.infra.queues.get("notify");
    const delayedJob = await queue.getJob(buildJobId("notify", later?.id ?? ""));
    expect(delayedJob?.opts.delay).toBe(7 * MINUTE);
    const immediateJob = await queue.getJob(buildJobId("notify", now?.id ?? ""));
    expect(immediateJob?.opts.delay ?? 0).toBe(0);

    expect(await alerting().deliver(now?.id ?? "")).toBe("sent");
    expect(await alertEmailTitles(accountEmail)).toContain(`Checkout down ${run}`);
    expect(await alertEmailTitles(secondEmail)).not.toContain(`Checkout down ${run}`);
    /* A job that runs twice sends once. */
    expect(await alerting().deliver(now?.id ?? "")).toBe("skipped");

    clock.advance(7 * MINUTE);
    expect(await alerting().deliver(later?.id ?? "")).toBe("sent");
    expect(await alertEmailTitles(secondEmail)).toContain(`Checkout down ${run}`);

    /* The incident's delivery log names the person where a channel would be. */
    const log = await api("get", `/incidents/${incident.id}/deliveries`);
    expect(log.status, log.text).toBe(200);
    const entries = (
      log.body.data as { channelName: string; channelType: string; status: string }[]
    ).filter((e) => e.channelType === "email" && e.status === "sent");
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.every((e) => e.channelName.length > 0)).toBe(true);
  });

  it("drops a delayed step once the incident has been acknowledged", async () => {
    const incident = await openIncident(`Search slow ${run}`);
    await alerting().notifyUser({
      incidentId: incident.id,
      eventKey: `page.${incident.id}`,
      userId,
    });
    const personal = (await alerting().deliveriesFor(incident.id)).filter((d) => d.userId !== null);
    const now = personal.find((d) => d.dueAt === null);
    const later = personal.find((d) => d.dueAt !== null);
    expect(await alerting().deliver(now?.id ?? "")).toBe("sent");

    clock.advance(3 * MINUTE);
    const ack = await api("post", `/incidents/${incident.number}/acknowledge`);
    expect(ack.status, ack.text).toBe(200);

    clock.advance(4 * MINUTE);
    expect(await alerting().deliver(later?.id ?? "")).toBe("skipped");
    expect(await alertEmailTitles(secondEmail)).not.toContain(`Search slow ${run}`);
    const after = (await alerting().deliveriesFor(incident.id)).find((d) => d.id === later?.id);
    expect(after?.status).toBe("skipped");
    expect(after?.error).toMatch(/acknowledged before this step was due/);
  });

  it("plans nothing for an incident that is already acknowledged or for a stranger", async () => {
    const incident = await openIncident(`Late page ${run}`);
    expect(
      await alerting().notifyUser({
        incidentId: incident.id,
        eventKey: `page.${incident.id}`,
        userId: "0190e2e0-0000-7000-8000-00000000ffff",
      }),
    ).toBe(0);
    await api("post", `/incidents/${incident.number}/acknowledge`);
    expect(
      await alerting().notifyUser({
        incidentId: incident.id,
        eventKey: `page.${incident.id}`,
        userId,
      }),
    ).toBe(0);
  });
});
