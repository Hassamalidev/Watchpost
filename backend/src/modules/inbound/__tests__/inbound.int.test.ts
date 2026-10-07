/*
 * P4-T06: every source's firing and resolved payload opens and closes exactly one incident (dedup
 * on repeats, auto-resolve), a source's alerts stay in its own workspace and key space, and the
 * tester shows what a payload would do without doing it.
 */
import { randomBytes } from "node:crypto";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  INBOUND_KINDS,
  INBOUND_SAMPLES,
  type InboundKind,
  type InboundResult,
  type InboundSourceView,
} from "@app/shared";
import {
  WEB_ORIGIN,
  buildContainerApp,
  signUpVerified,
} from "../../../__tests__/helpers/container-app.js";
import { parseInbound } from "../parsers.js";

describe("parsers", () => {
  it("read each tool's sample pair as a trigger and a resolve with the same key", () => {
    for (const kind of INBOUND_KINDS) {
      const [fired] = parseInbound(kind, INBOUND_SAMPLES[kind].trigger);
      const [cleared] = parseInbound(kind, INBOUND_SAMPLES[kind].resolve);
      expect(fired?.status, kind).toBe("trigger");
      expect(cleared?.status, kind).toBe("resolve");
      expect(cleared?.key, kind).toBe(fired?.key);
      expect(fired?.title.length, kind).toBeGreaterThan(3);
    }
  });

  it("maps severities and titles the way each tool means them", () => {
    expect(parseInbound("alertmanager", INBOUND_SAMPLES.alertmanager.trigger)[0]).toMatchObject({
      title: "5xx rate above 5% on api-1",
      severity: "critical",
      link: "https://prometheus.example.com/graph?g0.expr=errors",
    });
    /* A Prometheus warning doesn't wake anyone. */
    expect(parseInbound("grafana", INBOUND_SAMPLES.grafana.trigger)[0]?.severity).toBe("low");
    expect(parseInbound("datadog", INBOUND_SAMPLES.datadog.trigger)[0]).toMatchObject({
      title: "CPU above 95% on web-3",
      severity: "high",
    });
    expect(parseInbound("email", INBOUND_SAMPLES.email.trigger)[0]?.title).toBe("web-1 HTTP");
    expect(
      parseInbound("grafana", { state: "alerting", ruleName: "Latency", ruleId: 7 })[0],
    ).toMatchObject({ status: "trigger", key: "7", title: "Latency" });
    expect(
      parseInbound("grafana", { state: "ok", ruleName: "Latency", ruleId: 7 })[0]?.status,
    ).toBe("resolve");
    expect(parseInbound("email", { subject: "[FIRING:2] Disk full on db-1" })[0]?.title).toBe(
      "Disk full on db-1",
    );
  });

  it("splits an Alertmanager group into one event per alert", () => {
    const group = {
      alerts: [
        { status: "firing", labels: { alertname: "A", instance: "x" }, fingerprint: "f1" },
        { status: "resolved", labels: { alertname: "B" }, fingerprint: "f2" },
      ],
    };
    expect(
      parseInbound("alertmanager", group).map((e) => `${e.status}:${e.key}:${e.title}`),
    ).toEqual(["trigger:f1:A (x)", "resolve:f2:B"]);
  });

  it("refuses payloads it can't read, saying what is missing", () => {
    expect(() => parseInbound("generic", { status: "trigger" })).toThrow(/"title"/);
    expect(() => parseInbound("alertmanager", { hello: "world" })).toThrow(/"alerts"/);
    expect(() => parseInbound("datadog", { title: "x" })).toThrow(/template/);
    expect(() => parseInbound("email", {})).toThrow(/subject/);
    expect(() =>
      parseInbound("alertmanager", {
        alerts: Array.from({ length: 51 }, (_, i) => ({ labels: { alertname: `A${i}` } })),
      }),
    ).toThrow(/At most 50/);
  });
});

describe("inbound sources over HTTP", () => {
  const ctx = buildContainerApp({ authRateLimit: false });
  const run = randomBytes(4).toString("hex");
  let owner: TestAgent;
  let other: TestAgent;
  let ws = "";
  let otherWs = "";

  const api = (
    agent: TestAgent,
    workspace: string,
    method: "get" | "post" | "delete",
    path: string,
  ) => agent[method](`/api/w/${workspace}${path}`).set("Origin", WEB_ORIGIN);
  /* What the other tool does: post to the URL, no session. */
  const send = (url: string, body: unknown) =>
    request(ctx.app)
      .post(new URL(url).pathname)
      .send(body as object);
  async function incidents(agent: TestAgent, workspace: string) {
    const res = await api(agent, workspace, "get", "/incidents?limit=100");
    return res.body.data as {
      id: string;
      number: number;
      title: string;
      status: string;
      source: string;
    }[];
  }
  async function newSource(kind: InboundKind, name: string) {
    const created = await api(owner, ws, "post", "/inbound-sources").send({ kind, name });
    expect(created.status, created.text).toBe(201);
    return created.body as InboundSourceView & { url: string };
  }

  beforeAll(async () => {
    owner = request.agent(ctx.app);
    other = request.agent(ctx.app);
    await signUpVerified(ctx, owner, `inbound-owner-${run}@example.com`);
    await signUpVerified(ctx, other, `inbound-other-${run}@example.com`);
    const mine = await owner
      .post("/api/auth/organization/create")
      .set("Origin", WEB_ORIGIN)
      .send({ name: "Inbound Co", slug: `inbound-${run}` });
    ws = mine.body.id as string;
    const theirs = await other
      .post("/api/auth/organization/create")
      .set("Origin", WEB_ORIGIN)
      .send({ name: "Other Co", slug: `inbound-other-${run}` });
    otherWs = theirs.body.id as string;
  }, 120_000);

  afterAll(async () => {
    await ctx.container.close();
  });

  for (const kind of INBOUND_KINDS) {
    it(`${kind}: a firing and a resolved payload open and close exactly one incident`, async () => {
      const source = await newSource(kind, `${kind} source`);
      expect(source.url).toMatch(
        new RegExp(`/api/inbound/[A-Za-z0-9_-]{16,64}${kind === "email" ? "/email" : ""}$`),
      );
      const before = (await incidents(owner, ws)).length;

      const fired = await send(source.url, INBOUND_SAMPLES[kind].trigger);
      expect(fired.status, fired.text).toBe(202);
      expect(fired.body as InboundResult).toEqual({
        received: 1,
        opened: 1,
        resolved: 0,
        ignored: 0,
      });
      /* The tool sends the same alert again (a repeat interval): still one incident. */
      const repeat = await send(source.url, INBOUND_SAMPLES[kind].trigger);
      expect(repeat.body as InboundResult).toEqual({
        received: 1,
        opened: 0,
        resolved: 0,
        ignored: 1,
      });

      const open = (await incidents(owner, ws)).filter((i) => i.status !== "resolved");
      expect((await incidents(owner, ws)).length).toBe(before + 1);
      expect(open).toHaveLength(1);
      expect(open[0]?.source).toBe("inbound");

      const cleared = await send(source.url, INBOUND_SAMPLES[kind].resolve);
      expect(cleared.body as InboundResult).toEqual({
        received: 1,
        opened: 0,
        resolved: 1,
        ignored: 0,
      });
      const again = await send(source.url, INBOUND_SAMPLES[kind].resolve);
      expect(again.body as InboundResult).toEqual({
        received: 1,
        opened: 0,
        resolved: 0,
        ignored: 1,
      });
      const after = await incidents(owner, ws);
      expect(after.length).toBe(before + 1);
      expect(after.filter((i) => i.status !== "resolved")).toHaveLength(0);

      /* The same alert firing later is a new incident. */
      const later = await send(source.url, INBOUND_SAMPLES[kind].trigger);
      expect((later.body as InboundResult).opened).toBe(1);
      await send(source.url, INBOUND_SAMPLES[kind].resolve);
    });
  }

  it("keeps two sources apart: one can't close the other's incident", async () => {
    const a = await newSource("generic", "Tool A");
    const b = await newSource("generic", "Tool B");
    await send(a.url, INBOUND_SAMPLES.generic.trigger);
    const wrong = await send(b.url, INBOUND_SAMPLES.generic.resolve);
    expect((wrong.body as InboundResult).ignored).toBe(1);
    expect((await incidents(owner, ws)).filter((i) => i.status !== "resolved")).toHaveLength(1);
    await send(a.url, INBOUND_SAMPLES.generic.resolve);
    /* Nothing reached the other workspace. */
    expect(await incidents(other, otherWs)).toHaveLength(0);
  });

  it("answers 404 for an unknown or old token and 400 for an unreadable payload", async () => {
    const source = await newSource("alertmanager", "Rotating");
    expect((await send(source.url, { not: "alerts" })).status).toBe(400);
    expect(
      (
        await request(ctx.app)
          .post(`/api/inbound/${"x".repeat(32)}`)
          .send({ title: "x" })
      ).status,
    ).toBe(404);
    expect((await request(ctx.app).post("/api/inbound/short").send({ title: "x" })).status).toBe(
      404,
    );

    const rotated = await api(owner, ws, "post", `/inbound-sources/${source.id}/rotate`);
    expect(rotated.status, rotated.text).toBe(200);
    expect(rotated.body.url).not.toBe(source.url);
    expect((await send(source.url, INBOUND_SAMPLES.alertmanager.trigger)).status).toBe(404);
    const fresh = await send(rotated.body.url as string, INBOUND_SAMPLES.alertmanager.trigger);
    expect(fresh.status).toBe(202);
    await send(rotated.body.url as string, INBOUND_SAMPLES.alertmanager.resolve);

    const listed = (await api(owner, ws, "get", "/inbound-sources")).body
      .data as InboundSourceView[];
    const row = listed.find((s) => s.id === source.id);
    expect(row?.lastReceivedAt).not.toBeNull();
    /* The list never shows a URL or a whole token. */
    expect(JSON.stringify(listed)).not.toContain("/api/inbound/");
    expect(row?.tokenHint).toHaveLength(6);
  });

  it("shows what a payload would do without opening anything, and only to its own workspace", async () => {
    const source = await newSource("datadog", "Datadog");
    const before = (await incidents(owner, ws)).length;
    const preview = await api(owner, ws, "post", `/inbound-sources/${source.id}/test`).send({
      payload: INBOUND_SAMPLES.datadog.trigger,
    });
    expect(preview.status, preview.text).toBe(200);
    expect(preview.body.data).toEqual([
      expect.objectContaining({
        status: "trigger",
        title: "CPU above 95% on web-3",
        severity: "high",
      }),
    ]);
    const bad = await api(owner, ws, "post", `/inbound-sources/${source.id}/test`).send({
      payload: { nope: true },
    });
    expect(bad.status).toBe(400);
    expect((await incidents(owner, ws)).length).toBe(before);

    const foreign = await api(other, otherWs, "post", `/inbound-sources/${source.id}/test`).send({
      payload: INBOUND_SAMPLES.datadog.trigger,
    });
    expect(foreign.status).toBe(404);
    expect((await api(other, otherWs, "delete", `/inbound-sources/${source.id}`)).status).toBe(404);
    expect((await api(owner, ws, "delete", `/inbound-sources/${source.id}`)).status).toBe(204);
    expect((await send(source.url, INBOUND_SAMPLES.datadog.trigger)).status).toBe(404);
  });
});
