/*
 * Input no validator expected must come back as "bad request", never as a server error: an address
 * that can't be decoded, a NUL character in text, and text that isn't an ID where one is expected.
 * Found by sending awkward input to every route of the running app.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { unstorableInput } from "../infra/auth/auth.js";
import { WEB_ORIGIN, buildContainerApp, signUpVerified } from "./helpers/container-app.js";

const ctx = buildContainerApp({ authRateLimit: false });
const run = randomBytes(4).toString("hex");
let owner: TestAgent;
let ws = "";

beforeAll(async () => {
  owner = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `robust-${run}@example.com`);
  const created = await owner
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "Robust Co", slug: `robust-${run}` });
  ws = created.body.id as string;
}, 120_000);

afterAll(async () => {
  await ctx.container.close();
});

describe("awkward input", () => {
  it("answers 400 for an address that isn't text", async () => {
    for (const path of [
      "/api/public/status/%ff%fe",
      "/api/public/status/%ff%fe/rss",
      "/api/public/status-widget/%ff%fe.svg",
      "/api/hb/%ff%fe",
      "/api/inbound/%ff%fe",
      `/api/w/${ws}/monitors/%ff`,
    ]) {
      const res = await owner.get(path).set("Origin", WEB_ORIGIN);
      expect(res.status, path).toBe(400);
      expect(res.body.code, path).toBe("validation_failed");
    }
  });

  it("answers 400 for a NUL character, in an address and in a body", async () => {
    const asked = await request(ctx.app).get("/api/internal/tls/ask?domain=%00");
    expect([400, 404]).toContain(asked.status);
    const named = await owner
      .post(`/api/w/${ws}/monitors`)
      .set("Origin", WEB_ORIGIN)
      .send({
        settings: { name: "bad\u0000name" },
        config: { type: "http", url: "https://example.com" },
      });
    expect(named.status, named.text).toBe(400);
    const page = await owner
      .post(`/api/w/${ws}/status-pages`)
      .set("Origin", WEB_ORIGIN)
      .send({ name: "page\u0000", slug: `robust-${run}` });
    expect(page.status, page.text).toBe(400);
  });

  it("answers 400 from the sign-in endpoints for text that isn't an ID", async () => {
    const accept = await owner
      .post("/api/auth/organization/accept-invitation")
      .set("Origin", WEB_ORIGIN)
      .send({ invitationId: "nope" });
    expect(accept.status, accept.text).toBe(400);
    expect(accept.body.message).toContain("invitationId");
    const invitation = await owner
      .get("/api/auth/organization/get-invitation?id=cut-off-link")
      .set("Origin", WEB_ORIGIN);
    expect(invitation.status, invitation.text).toBe(400);
    const invite = await owner
      .post("/api/auth/organization/invite-member")
      .set("Origin", WEB_ORIGIN)
      .send({ email: "x@example.com", role: "member", organizationId: "not an id" });
    expect(invite.status, invite.text).toBe(400);
    const remove = await owner
      .post("/api/auth/organization/remove-member")
      .set("Origin", WEB_ORIGIN)
      .send({ memberIdOrEmail: "not-an-id", organizationId: ws });
    expect(remove.status, remove.text).toBe(400);
    const nul = await request(ctx.app)
      .post("/api/auth/sign-in/email")
      .set("Origin", WEB_ORIGIN)
      .send({ email: "a\u0000@example.com", password: "whatever-123" });
    expect(nul.status, nul.text).toBe(400);
  });

  it("leaves ordinary sign-in requests alone", () => {
    expect(unstorableInput({ email: "a@example.com", password: "x" })).toBeUndefined();
    expect(unstorableInput({ organizationId: null })).toBeUndefined();
    expect(unstorableInput({ memberIdOrEmail: "a@example.com" })).toBeUndefined();
    expect(
      unstorableInput({ invitationId: "0199c0de-0000-7000-8000-000000000001" }),
    ).toBeUndefined();
    expect(unstorableInput(undefined)).toBeUndefined();
    expect(unstorableInput({ id: "nope" })).toBe("id is not a valid ID.");
  });
});
