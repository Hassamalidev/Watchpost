/*
 * P8-T01: multi-step API checks against a small API started in-process: sign in, use the token,
 * check what comes back. Every way a step can fail names the step, and neither the password nor the
 * token it earned shows up in what the probe reports.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { once } from "node:events";
import { monitorConfigSchema, type MonitorConfigInput } from "@app/shared";
import type { CheckContext } from "../../executor/executor.js";
import { createAddressPolicy } from "../../net/address-policy.js";
import { runMultistep } from "../multistep.js";

const policy = createAddressPolicy({ allowCidrs: ["127.0.0.1/32", "::1/128"] });
const PASSWORD = "correct-horse-battery";
const TOKEN = "tok_9f8e7d6c5b4a3210";
let server: http.Server;
let base = "";
/* What the API saw, to check what later steps sent. */
let seen: Array<{ method: string; url: string; authorization?: string; body: string }> = [];

const ctx = (overrides: Partial<CheckContext> = {}): CheckContext => ({
  timeoutMs: 5_000,
  signal: new AbortController().signal,
  policy,
  ...overrides,
});

type Multistep = Extract<MonitorConfigInput, { type: "multistep" }>;
const run = (config: Omit<Multistep, "type">, overrides: Partial<CheckContext> = {}) =>
  runMultistep(monitorConfigSchema.parse({ type: "multistep", ...config }), ctx(overrides));

const login = (password = "{{password}}") => ({
  name: "Sign in",
  url: `${base}/login`,
  method: "POST" as const,
  headers: [{ name: "content-type", value: "application/json" }],
  body: `{"user":"sara","password":"${password}"}`,
  extract: [
    { name: "token", from: "body" as const, expression: "session.token" },
    { name: "request", from: "header" as const, expression: "X-Request-Id" },
  ],
});
const profile = (extra: Record<string, unknown> = {}) => ({
  name: "Read profile",
  url: `${base}/me?trace={{request}}`,
  headers: [{ name: "Authorization", value: "Bearer {{token}}" }],
  assertions: [{ expression: "user.name", operator: "==" as const, expected: "sara" }],
  ...extra,
});
const secrets = [{ name: "password", value: PASSWORD }];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const authorization = req.headers.authorization;
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        ...(authorization === undefined ? {} : { authorization }),
        body,
      });
      const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(value));
      };
      const path = (req.url ?? "").split("?")[0];
      if (path === "/login") {
        if (!body.includes(PASSWORD)) return json(401, { error: "wrong password" });
        return json(200, { session: { token: TOKEN, ttl: 3600 } }, { "x-request-id": "req-12345" });
      }
      if (path === "/me") {
        if (authorization !== `Bearer ${TOKEN}`) {
          return json(403, { error: `token ${authorization ?? "missing"} is not valid` });
        }
        return json(200, { user: { name: "sara", plan: "pro", seats: 5 } });
      }
      if (path === "/text") {
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end("not json");
      }
      if (path === "/slow") {
        setTimeout(() => json(200, {}), 600);
        return;
      }
      return json(404, { error: "no such route" });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("multi-step API check", () => {
  it("signs in, carries the token and a header on, and passes when every step holds", async () => {
    seen = [];
    const outcome = await run({ secrets, steps: [login(), profile()] });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(outcome.httpStatus).toBe(200);
    expect(outcome.details).toMatchObject({
      steps: [
        { name: "Sign in", status: 200 },
        { name: "Read profile", status: 200 },
      ],
    });
    expect(seen).toMatchObject([
      { method: "POST", url: "/login", body: `{"user":"sara","password":"${PASSWORD}"}` },
      { method: "GET", url: "/me?trace=req-12345", authorization: `Bearer ${TOKEN}` },
    ]);
    /* Nothing the probe reports carries the password or the token. */
    expect(JSON.stringify(outcome)).not.toContain(PASSWORD);
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
  });

  it("stops at the first step that fails and names it", async () => {
    seen = [];
    const outcome = await run({
      secrets: [{ name: "password", value: "not-the-password" }],
      steps: [login(), profile()],
    });
    expect(outcome).toMatchObject({
      ok: false,
      errorCode: "http_status_unexpected",
      message: 'Step 1 "Sign in": HTTP 401 (expected 200-299)',
      httpStatus: 401,
      details: { failedStep: 1, steps: [{ name: "Sign in", status: 401 }] },
    });
    expect(outcome.evidence?.bodySnippet).toContain("wrong password");
    /* The second request was never made. */
    expect(seen).toHaveLength(1);
  });

  it("fails on an assertion, saying what the value was", async () => {
    const outcome = await run({
      secrets,
      steps: [
        login(),
        profile({
          assertions: [
            { expression: "user.name", operator: "==", expected: "sara" },
            { expression: "user.seats", operator: ">", expected: "10" },
          ],
        }),
      ],
    });
    expect(outcome).toMatchObject({
      ok: false,
      errorCode: "json_query_failed",
      message: 'Step 2 "Read profile": user.seats was 5, expected > "10"',
      details: { failedStep: 2 },
    });
  });

  it("compares against a value from an earlier step", async () => {
    const outcome = await run({
      secrets,
      steps: [
        { ...login(), extract: [...login().extract, { name: "ttl", expression: "session.ttl" }] },
        {
          ...profile(),
          assertions: [{ expression: "user.seats * 720", operator: "==", expected: "{{ttl}}" }],
        },
      ],
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  });

  it("says when there is nothing to extract", async () => {
    const fromBody = await run({
      secrets,
      steps: [
        { ...login(), extract: [{ name: "token", expression: "session.jwt" }] },
        profile({ url: `${base}/me` }),
      ],
    });
    expect(fromBody).toMatchObject({
      ok: false,
      errorCode: "json_query_failed",
      message: 'Step 1 "Sign in": session.jwt found nothing to take "token" from',
    });
    const fromHeader = await run({
      secrets,
      steps: [
        {
          ...login(),
          extract: [
            { name: "token", expression: "session.token" },
            { name: "request", from: "header", expression: "X-Trace" },
          ],
        },
        profile(),
      ],
    });
    expect(fromHeader.message).toBe('Step 1 "Sign in": no "X-Trace" header to take "request" from');
  });

  it("strikes secrets and extracted values out of what it reports", async () => {
    /* The API echoes the bad credential back in its error. */
    const outcome = await run({
      secrets,
      steps: [
        login(),
        {
          name: "Read profile",
          url: `${base}/me`,
          headers: [{ name: "Authorization", value: "Bearer {{token}}-stale" }],
        },
      ],
    });
    expect(outcome).toMatchObject({ ok: false, httpStatus: 403, details: { failedStep: 2 } });
    expect(outcome.evidence?.bodySnippet).toContain("token Bearer ***-stale is not valid");
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
    expect(JSON.stringify(outcome)).not.toContain(PASSWORD);
  });

  it("fails on a body that isn't JSON only when a step reads it", async () => {
    const reads = await run({
      steps: [
        {
          name: "Text",
          url: `${base}/text`,
          assertions: [{ expression: "ok", operator: "==", expected: "true" }],
        },
      ],
    });
    expect(reads).toMatchObject({ ok: false, errorCode: "json_invalid" });
    expect(reads.message).toMatch(/^Step 1 "Text": invalid JSON/);
    const ignores = await run({ steps: [{ name: "Text", url: `${base}/text` }] });
    expect(ignores.ok).toBe(true);
  });

  it("shares one time budget between the steps", async () => {
    const outcome = await run(
      {
        steps: [
          { name: "Slow one", url: `${base}/slow` },
          { name: "Slow two", url: `${base}/slow` },
        ],
      },
      { timeoutMs: 900 },
    );
    expect(outcome).toMatchObject({ ok: false, details: { failedStep: 2 } });
    expect(outcome.message).toMatch(/^Step 2 "Slow two": /);
  });

  it("reports a network failure with the step it happened in", async () => {
    const outcome = await run({
      steps: [
        { name: "Up", url: `${base}/me`, acceptedStatusCodes: ["403"] },
        { name: "Private", url: "http://10.255.255.1/x" },
      ],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.details).toMatchObject({ failedStep: 2 });
    expect(outcome.message).toMatch(/^Step 2 "Private": /);
  });
});

describe("multi-step config", () => {
  const parse = (config: unknown) => monitorConfigSchema.safeParse(config);
  const step = (patch: Record<string, unknown> = {}) => ({
    name: "One",
    url: "https://api.example.com/health",
    ...patch,
  });

  it("wants every {{variable}} to exist before it is used", () => {
    expect(
      parse({ type: "multistep", steps: [step({ url: "https://api.example.com/{{id}}" })] }),
    ).toMatchObject({ success: false });
    expect(
      parse({
        type: "multistep",
        steps: [
          step({ extract: [{ name: "id", expression: "id" }] }),
          step({ name: "Two", url: "https://api.example.com/items/{{id}}" }),
        ],
      }).success,
    ).toBe(true);
    /* A value can't be used in the step that extracts it. */
    expect(
      parse({
        type: "multistep",
        steps: [
          step({
            url: "https://api.example.com/items/{{id}}",
            extract: [{ name: "id", expression: "id" }],
          }),
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps the host of every step written out, so a variable can't redirect a secret", () => {
    for (const url of ["{{base}}/x", "https://{{host}}/x", "https://api.example.com:{{port}}/x"]) {
      expect(
        parse({
          type: "multistep",
          secrets: [
            { name: "base", value: "https://x.example" },
            { name: "host", value: "x.example" },
            { name: "port", value: "8443" },
          ],
          steps: [step({ url })],
        }).success,
        url,
      ).toBe(false);
    }
  });

  it("sends credentials in headers only as secrets", () => {
    const literal = parse({
      type: "multistep",
      steps: [step({ headers: [{ name: "Authorization", value: "Bearer abc123" }] })],
    });
    expect(literal.success).toBe(false);
    expect(JSON.stringify(literal.error?.issues)).toContain("Secrets");
    expect(
      parse({
        type: "multistep",
        secrets: [{ name: "key", value: "abc123" }],
        steps: [step({ headers: [{ name: "X-Api-Key", value: "{{key}}" }] })],
      }).success,
    ).toBe(true);
  });

  it("takes each name once", () => {
    expect(
      parse({
        type: "multistep",
        secrets: [
          { name: "key", value: "a" },
          { name: "key", value: "b" },
        ],
        steps: [step()],
      }).success,
    ).toBe(false);
    expect(parse({ type: "multistep", steps: [] }).success).toBe(false);
  });
});
