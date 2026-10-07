/*
 * P4-T03b: the iCal writer, and a person's calendar feed over its token URL (their own shifts only,
 * a new token replaces the old one, nothing for an unknown token).
 */
import { randomBytes } from "node:crypto";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeClock } from "../../../core/clock.js";
import {
  WEB_ORIGIN,
  buildContainerApp,
  signUpVerified,
} from "../../../__tests__/helpers/container-app.js";
import { foldLine, toICalendar } from "../ical.js";

describe("iCalendar writer", () => {
  const now = new Date("2026-10-07T12:00:00Z");

  it("writes UTC events with CRLF line ends and escaped text", () => {
    const text = toICalendar({
      name: "On-call (Acme, Inc.)",
      now,
      events: [
        {
          uid: "abc@watchpost",
          startsAt: new Date("2026-10-12T09:00:00Z"),
          endsAt: new Date("2026-10-19T09:00:00Z"),
          summary: "On call: Primary; EU",
          description: "Line one\nLine two",
        },
      ],
    });
    expect(text.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(text.split("\r\n").every((line) => !line.includes("\n"))).toBe(true);
    expect(text).toContain("X-WR-CALNAME:On-call (Acme\\, Inc.)");
    expect(text).toContain("DTSTAMP:20261007T120000Z");
    expect(text).toContain("DTSTART:20261012T090000Z");
    expect(text).toContain("DTEND:20261019T090000Z");
    expect(text).toContain("SUMMARY:On call: Primary\\; EU");
    expect(text).toContain("DESCRIPTION:Line one\\nLine two");
  });

  it("folds long lines at 75 octets without splitting a character", () => {
    const line = `SUMMARY:${"é".repeat(80)}`;
    const folded = foldLine(line).split("\r\n");
    expect(folded.length).toBeGreaterThan(1);
    expect(folded.every((part) => Buffer.byteLength(part, "utf8") <= 75)).toBe(true);
    expect(folded.slice(1).every((part) => part.startsWith(" "))).toBe(true);
    expect(folded.map((part, i) => (i === 0 ? part : part.slice(1))).join("")).toBe(line);
    expect(foldLine("SHORT:line")).toBe("SHORT:line");
  });
});

describe("calendar feed", () => {
  const clock = createFakeClock("2026-10-07T12:00:00Z");
  const ctx = buildContainerApp({ authRateLimit: false, clock });
  const run = randomBytes(4).toString("hex");
  let owner: TestAgent;
  let other: TestAgent;
  let ws = "";
  let ownerId = "";
  let otherId = "";

  const api = (agent: TestAgent, method: "get" | "post" | "delete", path: string) =>
    agent[method](`/api/w/${ws}${path}`).set("Origin", WEB_ORIGIN);
  const feedPath = (url: string) => new URL(url).pathname;

  beforeAll(async () => {
    owner = request.agent(ctx.app);
    other = request.agent(ctx.app);
    const ownerEmail = `feed-owner-${run}@example.com`;
    const otherEmail = `feed-other-${run}@example.com`;
    await signUpVerified(ctx, owner, ownerEmail);
    await signUpVerified(ctx, other, otherEmail);
    const created = await owner
      .post("/api/auth/organization/create")
      .set("Origin", WEB_ORIGIN)
      .send({ name: "Feed Co", slug: `feed-${run}` });
    ws = created.body.id as string;
    const invite = await owner
      .post("/api/auth/organization/invite-member")
      .set("Origin", WEB_ORIGIN)
      .send({ email: otherEmail, role: "responder", organizationId: ws });
    await other
      .post("/api/auth/organization/accept-invitation")
      .set("Origin", WEB_ORIGIN)
      .send({ invitationId: invite.body.id });
    const members = await api(owner, "get", "/members");
    for (const m of members.body.data as { userId: string; email: string }[]) {
      if (m.email === ownerEmail) ownerId = m.userId;
      if (m.email === otherEmail) otherId = m.userId;
    }
    const schedule = await api(owner, "post", "/schedules").send({
      name: "Primary",
      timezone: "UTC",
      layers: [
        {
          name: "Weekly",
          rotation: "weekly",
          startsAt: "2026-10-05T09:00:00Z",
          participants: [ownerId, otherId],
        },
      ],
    });
    expect(schedule.status, schedule.text).toBe(201);
  }, 120_000);

  afterAll(async () => {
    await ctx.container.close();
  });

  it("gives each person a private URL with only their own shifts", async () => {
    expect((await api(owner, "get", "/me/oncall-feed")).body).toEqual({
      exists: false,
      createdAt: null,
    });
    const created = await api(owner, "post", "/me/oncall-feed");
    expect(created.status, created.text).toBe(201);
    const url = created.body.url as string;
    expect(url).toMatch(/\/api\/oncall\/ical\/[A-Za-z0-9_-]{20,64}\.ics$/);
    expect((await api(owner, "get", "/me/oncall-feed")).body.exists).toBe(true);

    /* No session: a calendar app only has the URL. */
    const feed = await request(ctx.app).get(feedPath(url));
    expect(feed.status).toBe(200);
    expect(feed.headers["content-type"]).toMatch(/^text\/calendar/);
    expect(feed.text).toContain("X-WR-CALNAME:On-call (Feed Co)");
    /* The owner holds 5–12 and 19–26 October, the responder the weeks between. */
    expect(feed.text).toContain("DTSTART:20261005T090000Z");
    expect(feed.text).toContain("DTEND:20261012T090000Z");
    expect(feed.text).toContain("DTSTART:20261019T090000Z");
    expect(feed.text).not.toContain("DTSTART:20261012T090000Z");
    expect(feed.text).toContain("SUMMARY:On call: Primary");

    const theirs = await api(other, "post", "/me/oncall-feed");
    const otherFeed = await request(ctx.app).get(feedPath(theirs.body.url as string));
    expect(otherFeed.text).toContain("DTSTART:20261012T090000Z");
    expect(otherFeed.text).not.toContain("DTSTART:20261005T090000Z");
  });

  it("replaces the URL on request and answers 404 for the old or a made-up one", async () => {
    const first = (await api(owner, "post", "/me/oncall-feed")).body.url as string;
    const second = (await api(owner, "post", "/me/oncall-feed")).body.url as string;
    expect(second).not.toBe(first);
    expect((await request(ctx.app).get(feedPath(first))).status).toBe(404);
    expect((await request(ctx.app).get(feedPath(second))).status).toBe(200);
    expect((await request(ctx.app).get(`/api/oncall/ical/${"x".repeat(43)}.ics`)).status).toBe(404);
    expect((await request(ctx.app).get("/api/oncall/ical/short.ics")).status).toBe(404);

    expect((await api(owner, "delete", "/me/oncall-feed")).status).toBe(204);
    expect((await request(ctx.app).get(feedPath(second))).status).toBe(404);
  });
});
