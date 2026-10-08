/*
 * P5-T01 without a database or a network: redaction, the Claude client's request and errors, the
 * guarded generation path (budget, kill switch, circuit breaker, retry, validation, metering), and
 * the eval fixtures.
 */
import { describe, expect, it } from "vitest";
import { pino } from "pino";
import { createFakeClock } from "../../../core/clock.js";
import { createWorkspaceScope } from "../../../core/workspace-scope.js";
import {
  AI_TIMEOUT_MS,
  AiError,
  aiCostMicros,
  createAnthropicClient,
  createFakeAiClient,
  type AiClient,
} from "../../../infra/anthropic/index.js";
import type { AiBudget } from "../../credits/index.js";
import type { AiRepository } from "../ai.repository.js";
import { BREAKER_FAILURES, BREAKER_OPEN_MS, createAiService } from "../ai.service.js";
import { judgeExplanation } from "../evals/checks.js";
import { EXPLAINER_CASES } from "../evals/fixtures.js";
import { PROMPTS, promptSchema } from "../prompts.js";
import {
  INTERNAL,
  MAX_TEXT,
  REDACTED,
  internalDetailIn,
  redact,
  redactText,
  redactUrl,
  scrubInternal,
} from "../redact.js";
import type { AiGenerationRow } from "../schema/ai.js";

describe("redaction", () => {
  it("hides values under keys that name a secret, at any depth", () => {
    const out = redact({
      headers: {
        Authorization: "Bearer abc.def.ghi",
        "X-Api-Key": "k-123456",
        accept: "text/html",
      },
      nested: [{ password: "hunter2", user: "sara" }],
      sessionToken: "s3cr3t",
      note: null,
    }) as Record<string, unknown>;
    expect(out.headers).toEqual({
      Authorization: REDACTED,
      "X-Api-Key": REDACTED,
      accept: "text/html",
    });
    expect(out.nested).toEqual([{ password: REDACTED, user: "sara" }]);
    expect(out.sessionToken).toBe(REDACTED);
    expect(out.note).toBeNull();
  });

  it("hides credentials, query values and emails inside text, and keeps what explains a failure", () => {
    expect(
      redactText(
        "curl -H 'Authorization: Bearer eyJhbGciOi.xyz' https://a.test/x?token=abc&page=2",
      ),
    ).toBe(
      `curl -H 'Authorization: Bearer ${REDACTED}' https://a.test/x?token=${REDACTED}&page=${REDACTED}`,
    );
    expect(redactText("mail sara.ahmed+ops@example.co.uk about it")).toBe("mail [email] about it");
    expect(redactText('login failed: password=hunter2 api_key: "abc 123", user=sara')).toBe(
      `login failed: password=${REDACTED} api_key: ${REDACTED}, user=sara`,
    );
    expect(redactUrl("https://user:pass@db.internal:5432/app?sslmode=require#frag")).toBe(
      `https://db.internal:5432/app?sslmode=${REDACTED}`,
    );
    expect(redactUrl("not a url")).toBe("not a url");
  });

  it("caps long text at 500 characters and deep or wide input", () => {
    const long = redact({ bodyExcerpt: "x".repeat(2_000) }) as { bodyExcerpt: string };
    expect(long.bodyExcerpt).toHaveLength(MAX_TEXT + 1);
    expect(long.bodyExcerpt.endsWith("…")).toBe(true);
    let deep: Record<string, unknown> = { leaf: "ok" };
    for (let i = 0; i < 20; i += 1) deep = { inner: deep };
    expect(JSON.stringify(redact(deep))).toContain("[omitted]");
    expect((redact(Array.from({ length: 200 }, (_, i) => i)) as unknown[]).length).toBe(50);
  });

  it("finds internal hosts and addresses in text meant for the public", () => {
    expect(internalDetailIn("The database at 10.0.4.12 is down")).toBe("10.0.4.12");
    expect(internalDetailIn("db-1.eu.acme.internal stopped answering")).toBe(
      "db-1.eu.acme.internal",
    );
    expect(internalDetailIn("fe80::1ff:fe23:4567:890a is unreachable")).toBeDefined();
    expect(internalDetailIn("We are investigating slow page loads.")).toBeUndefined();
    expect(internalDetailIn("shop.acme.com is slow", ["shop.acme.com"])).toBeUndefined();
    expect(internalDetailIn("shop.acme.com and api.internal", ["shop.acme.com"])).toBe(
      "api.internal",
    );
  });
});

describe("the Claude client", () => {
  const request = {
    system: "You explain.",
    user: '{"causeCode":"x"}',
    schema: promptSchema("explainer"),
    schemaName: "incident_explanation",
    maxTokens: 500,
  };

  it("asks for a structured answer with a cached system prompt, and reads usage", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createAnthropicClient({
      apiKey: "sk-ant-test-key-000000000000",
      model: "claude-haiku-4-5-20251001",
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            content: [{ type: "tool_use", name: "incident_explanation", input: { headline: "h" } }],
            usage: {
              input_tokens: 900,
              output_tokens: 120,
              cache_read_input_tokens: 400,
              cache_creation_input_tokens: null,
            },
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    const res = await client.complete(request);
    expect(res.output).toEqual({ headline: "h" });
    expect(res.usage).toEqual({
      inputTokens: 900,
      outputTokens: 120,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
    });
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test-key-000000000000");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      system: [{ type: "text", text: "You explain.", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: '{"causeCode":"x"}' }],
      tool_choice: { type: "tool", name: "incident_explanation" },
    });
    expect(AI_TIMEOUT_MS).toBe(8_000);
  });

  it("tells failures worth a retry from those that are not, without keeping the body", async () => {
    const answering = (status: number) =>
      createAnthropicClient({
        apiKey: "k".repeat(24),
        model: "m",
        fetch: (async () => new Response("the prompt echoed back", { status })) as typeof fetch,
      });
    await expect(answering(529).complete(request)).rejects.toMatchObject({ retryable: true });
    await expect(answering(429).complete(request)).rejects.toMatchObject({ retryable: true });
    const bad = await answering(400)
      .complete(request)
      .catch((err: unknown) => err as AiError);
    expect(bad).toBeInstanceOf(AiError);
    expect((bad as AiError).retryable).toBe(false);
    expect((bad as AiError).message).toBe("The AI provider answered HTTP 400.");
    const unreachable = createAnthropicClient({
      apiKey: "k".repeat(24),
      model: "m",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await expect(unreachable.complete(request)).rejects.toMatchObject({ retryable: true });
    const textOnly = createAnthropicClient({
      apiKey: "k".repeat(24),
      model: "m",
      fetch: (async () =>
        new Response(JSON.stringify({ content: [{ type: "text", text: "hi" }] }), {
          status: 200,
        })) as typeof fetch,
    });
    await expect(textOnly.complete(request)).rejects.toMatchObject({ retryable: false });
  });

  it("prices a call in micro-dollars, rounding up", () => {
    expect(
      aiCostMicros({
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(2_000);
    expect(
      aiCostMicros({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 15, cacheWriteTokens: 0 }),
    ).toBe(2);
    expect(
      aiCostMicros({
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 1_000,
        cacheWriteTokens: 400,
      }),
    ).toBe(100 + 50 + 100 + 500);
  });
});

const GOOD = EXPLAINER_CASES[0]?.answer;
const scope = createWorkspaceScope({ workspaceId: "0190e2e0-0000-7000-8000-0000000000a1" });
const REF = "0190e2e0-0000-7000-8000-0000000000b2";

function memoryRepository(): AiRepository {
  const rows: AiGenerationRow[] = [];
  return {
    async insert(_scope, row) {
      const full = { ...row, workspaceId: scope.workspaceId, feedback: null, feedbackBy: null };
      rows.push(full as AiGenerationRow);
      return full as AiGenerationRow;
    },
    async latestOk(_scope, kind, refId) {
      return rows.findLast((r) => r.kind === kind && r.refId === refId && r.status === "ok");
    },
    async find() {
      return undefined;
    },
    async setFeedback() {
      return undefined;
    },
  };
}

function harness(options: {
  client?: AiClient | undefined;
  budget?: Partial<AiBudget>;
  noClient?: boolean;
}) {
  const rows: AiGenerationRow[] = [];
  const usage: Array<{ kind: string; units: number; costMicros: number; ref: string }> = [];
  const clock = createFakeClock("2026-10-07T12:00:00Z");
  let ids = 0;
  const repository = {
    async insert(_scope, row) {
      const full = { ...row, workspaceId: scope.workspaceId, feedback: null, feedbackBy: null };
      rows.push(full as AiGenerationRow);
      return full as AiGenerationRow;
    },
    async latestOk(_scope, kind, refId) {
      return rows.findLast((r) => r.kind === kind && r.refId === refId && r.status === "ok");
    },
    async find() {
      return undefined;
    },
    async setFeedback() {
      return undefined;
    },
  } satisfies AiRepository;
  const service = createAiService({
    repository,
    client: options.noClient ? undefined : (options.client ?? createFakeAiClient(() => GOOD)),
    credits: {
      async aiBudget() {
        return {
          allowed: true,
          reason: "ok",
          funded: true,
          budgetMicros: 500_000,
          spentMicros: 0,
          remainingMicros: 500_000,
          periodStart: "2026-10-01T00:00:00.000Z",
          ...options.budget,
        };
      },
      async recordUsage(_scope, input) {
        usage.push(input);
        return true;
      },
    },
    clock,
    logger: pino({ level: "silent" }),
    newId: () => `0190e2e0-0000-7000-8000-${String((ids += 1)).padStart(12, "0")}`,
  });
  const explain = (evidence: Record<string, unknown> = { causeCode: "http_status_unexpected" }) =>
    service.generate(scope, { prompt: "explainer", refId: REF, evidence });
  return { service, rows, usage, clock, explain };
}

describe("generating", () => {
  it("redacts the evidence, validates the answer, meters the cost and stores it", async () => {
    const client = createFakeAiClient(() => GOOD);
    const h = harness({ client });
    const result = await h.explain(EXPLAINER_CASES[0]?.evidence);
    expect(result).toMatchObject({ ok: true, reused: false, model: "fake-model" });
    const sent = client.requests[0];
    expect(sent?.system).toBe(PROMPTS.explainer.system);
    expect(sent?.schemaName).toBe("incident_explanation");
    for (const secret of EXPLAINER_CASES[0]?.secrets ?? [])
      expect(sent?.user).not.toContain(secret);
    expect(h.usage).toEqual([
      {
        provider: "anthropic",
        kind: "explainer",
        units: 1_380,
        costMicros: 2_100,
        ref: h.rows[0]?.id,
      },
    ]);
    expect(h.rows[0]).toMatchObject({
      status: "ok",
      kind: "explainer",
      promptVersion: 1,
      costMicros: 2_100,
      inputTokens: 1_200,
      outputTokens: 180,
    });
  });

  it("budget cutoff: an exhausted budget, the kill switch and the platform cap make no call", async () => {
    for (const reason of ["budget_used", "disabled", "platform_cap"] as const) {
      const client = createFakeAiClient(() => GOOD);
      const h = harness({ client, budget: { allowed: false, reason } });
      expect(await h.explain()).toEqual({ ok: false, status: "skipped", reason });
      expect(client.requests).toHaveLength(0);
      expect(h.usage).toEqual([]);
      expect(h.rows[0]).toMatchObject({ status: "skipped", reason, costMicros: 0 });
    }
  });

  it("without a key nothing is called and nothing is stored", async () => {
    const h = harness({ noClient: true });
    expect(h.service.configured()).toBe(false);
    expect(await h.explain()).toEqual({ ok: false, status: "skipped", reason: "not_configured" });
    expect(h.rows).toEqual([]);
  });

  it("retries once on a failure worth retrying, and not on one that isn't", async () => {
    let calls = 0;
    const flaky: AiClient = {
      model: "m",
      async complete() {
        calls += 1;
        if (calls === 1) throw new AiError("The AI call timed out.", true);
        return {
          output: GOOD,
          model: "m",
          usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };
    expect((await harness({ client: flaky }).explain()).ok).toBe(true);
    expect(calls).toBe(2);

    let hard = 0;
    const broken: AiClient = {
      model: "m",
      async complete() {
        hard += 1;
        throw new AiError("The AI provider answered HTTP 400.", false);
      },
    };
    const h = harness({ client: broken });
    expect(await h.explain()).toEqual({
      ok: false,
      status: "failed",
      reason: "timeout_or_provider",
    });
    expect(hard).toBe(1);
    expect(h.usage).toEqual([]);
    expect(h.rows[0]).toMatchObject({ status: "failed", reason: "timeout_or_provider" });
  });

  it("an answer that doesn't fit the schema is refused, and its tokens are still metered", async () => {
    const h = harness({
      client: createFakeAiClient(() => ({ headline: "x".repeat(200), confidence: "certain" })),
    });
    expect(await h.explain()).toEqual({ ok: false, status: "failed", reason: "invalid_output" });
    expect(h.usage).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ status: "failed", reason: "invalid_output", output: null });
    expect(h.rows[0]?.costMicros).toBeGreaterThan(0);
  });

  it("the circuit opens after five failures in a row and closes after a minute", async () => {
    let calls = 0;
    let down = true;
    const client: AiClient = {
      model: "m",
      async complete() {
        calls += 1;
        if (down) throw new AiError("The AI provider answered HTTP 400.", false);
        return {
          output: GOOD,
          model: "m",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };
    const h = harness({ client });
    for (let i = 0; i < BREAKER_FAILURES; i += 1) await h.explain();
    expect(calls).toBe(BREAKER_FAILURES);
    expect(await h.explain()).toEqual({ ok: false, status: "skipped", reason: "circuit_open" });
    expect(calls).toBe(BREAKER_FAILURES);
    down = false;
    h.clock.advance(BREAKER_OPEN_MS + 1);
    expect((await h.explain()).ok).toBe(true);
  });

  it("with `once`, a stored answer is returned instead of paying for another", async () => {
    const client = createFakeAiClient(() => GOOD);
    const h = harness({ client });
    const first = await h.service.generate(scope, {
      prompt: "explainer",
      refId: REF,
      evidence: {},
      once: true,
    });
    const second = await h.service.generate(scope, {
      prompt: "explainer",
      refId: REF,
      evidence: {},
      once: true,
    });
    expect(first.ok && second.ok && second.reused).toBe(true);
    expect(first.ok && second.ok && second.generationId === first.generationId).toBe(true);
    expect(client.requests).toHaveLength(1);
  });
});

describe("answers for the public", () => {
  const draft = (
    h: ReturnType<typeof harness>,
    evidence: Record<string, unknown>,
    allowed?: string[],
  ) =>
    h.service.generate(scope, {
      prompt: "statusUpdate",
      refId: REF,
      evidence,
      ...(allowed === undefined ? {} : { allowedHosts: allowed }),
    });

  it("takes internal hosts and addresses out of what the model is shown", () => {
    expect(
      scrubInternal(
        {
          notes:
            "db-1.eu.acme.internal at 10.0.4.12 and fe80::1ff:fe23:4567:890a failed; shop.acme.com is slow",
          list: ["cache.internal", "fine"],
          n: 3,
        },
        ["shop.acme.com"],
      ),
    ).toEqual({
      notes: `${INTERNAL} at ${INTERNAL} and ${INTERNAL} failed; shop.acme.com is slow`,
      list: [INTERNAL, "fine"],
      n: 3,
    });
  });

  it("scrubs the evidence of a public prompt, and not of an internal one", async () => {
    const client = createFakeAiClient(() => ({ message: "We are looking into it." }));
    const h = harness({ client });
    await draft(h, { notes: "pg-3.acme.internal failed over" });
    expect(client.requests[0]?.user).not.toContain("pg-3.acme.internal");
    expect(client.requests[0]?.user).toContain(INTERNAL);
    /* The explainer is for the engineer on call: the host stays. */
    const internal = createFakeAiClient(() => GOOD);
    await harness({ client: internal }).explain({ target: "pg-3.acme.internal" });
    expect(internal.requests[0]?.user).toContain("pg-3.acme.internal");
  });

  it("refuses an answer that names a host or an address, and keeps one that names an allowed host", async () => {
    for (const leak of ["Restarting db-7.internal now.", "Traffic to 10.0.4.12 is dropped."]) {
      const h = harness({ client: createFakeAiClient(() => ({ message: leak })) });
      expect(await draft(h, {})).toEqual({
        ok: false,
        status: "failed",
        reason: "internal_detail",
      });
      expect(h.rows[0]).toMatchObject({
        status: "failed",
        reason: "internal_detail",
        output: null,
      });
      /* The tokens were used: the call is metered all the same. */
      expect(h.usage).toHaveLength(1);
    }
    const own = harness({
      client: createFakeAiClient(() => ({ message: "status.acme.com is slow to load." })),
    });
    expect((await draft(own, {}, ["status.acme.com"])).ok).toBe(true);
    expect((await draft(own, {})).ok).toBe(false);
  });
});

describe("the incident explainer", () => {
  const INCIDENT = "0190e2e0-0000-7000-8000-0000000000c3";
  function explainer(source: string, client = createFakeAiClient(() => GOOD)) {
    const stored: Array<Record<string, unknown>> = [];
    const service = createAiService({
      repository: memoryRepository(),
      client,
      credits: {
        async aiBudget() {
          return {
            allowed: true,
            reason: "ok",
            funded: true,
            budgetMicros: 1,
            spentMicros: 0,
            remainingMicros: 1,
            periodStart: "2026-10-01T00:00:00.000Z",
          };
        },
        async recordUsage() {
          return true;
        },
      },
      incidents: {
        async postmortemSource() {
          throw new Error("not used here");
        },
        async savePostmortem() {
          throw new Error("not used here");
        },
        async aiEvidence(incidentId) {
          return incidentId === INCIDENT
            ? {
                workspaceId: scope.workspaceId,
                evidence: { ...EXPLAINER_CASES[0]?.evidence, source },
              }
            : undefined;
        },
        async setAiSummary(_incidentId, summary) {
          if (stored.some((s) => s.generationId === summary.generationId)) return false;
          stored.push({ ...summary });
          return true;
        },
      },
      clock: createFakeClock("2026-10-07T12:00:00Z"),
      logger: pino({ level: "silent" }),
      newId: () => "0190e2e0-0000-7000-8000-0000000000d4",
    });
    return { service, stored, client };
  }

  it("explains an incident once and stores the answer on it", async () => {
    const { service, stored, client } = explainer("monitor");
    expect(await service.explainIncident(INCIDENT)).toBe("explained");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      headline: GOOD?.headline,
      generationId: "0190e2e0-0000-7000-8000-0000000000d4",
      model: "fake-model",
    });
    /* A second event for the same incident pays for nothing and stores nothing new. */
    expect(await service.explainIncident(INCIDENT)).toBe("already");
    expect(client.requests).toHaveLength(1);
    for (const secret of EXPLAINER_CASES[0]?.secrets ?? []) {
      expect(client.requests[0]?.user).not.toContain(secret);
    }
  });

  it("leaves fire drills, expiry warnings and unknown incidents alone", async () => {
    for (const source of ["drill", "expiry"]) {
      const { service, client } = explainer(source);
      expect(await service.explainIncident(INCIDENT)).toBe("skipped");
      expect(client.requests).toHaveLength(0);
    }
    const { service } = explainer("monitor");
    expect(await service.explainIncident("0190e2e0-0000-7000-8000-00000000ffff")).toBe("skipped");
  });

  it("a model that fails leaves the incident without a summary and nothing else changes", async () => {
    const broken: AiClient = {
      model: "m",
      async complete() {
        throw new AiError("The AI provider answered HTTP 400.", false);
      },
    };
    const { service, stored } = explainer("monitor", broken as never);
    expect(await service.explainIncident(INCIDENT)).toBe("failed");
    expect(stored).toEqual([]);
  });
});

describe("evals: incident explainer", () => {
  it("the answer's schema is what the model is given", () => {
    const schema = promptSchema("explainer");
    expect(schema).toMatchObject({ type: "object", additionalProperties: false });
    expect(Object.keys(schema.properties as object).sort()).toEqual([
      "confidence",
      "evidenceRefs",
      "headline",
      "likelyCause",
      "nextChecks",
    ]);
    expect(schema).not.toHaveProperty("$schema");
  });

  for (const fixture of EXPLAINER_CASES) {
    it(`${fixture.name}: nothing secret is sent, and the answer is valid and invents nothing`, () => {
      const sent = JSON.stringify(redact(fixture.evidence));
      for (const secret of fixture.secrets) expect(sent, secret).not.toContain(secret);
      expect(sent.length).toBeLessThan(4_000);
      expect(judgeExplanation(fixture.evidence, fixture.answer, fixture.secrets)).toEqual([]);
    });
  }

  it("the judge catches what it is there to catch", () => {
    const [fixture] = EXPLAINER_CASES;
    if (fixture === undefined) throw new Error("no fixtures");
    const judge = (patch: Record<string, unknown>) =>
      judgeExplanation(fixture.evidence, { ...fixture.answer, ...patch }, fixture.secrets);
    expect(judge({ evidenceRefs: ["dnsRecords"] })).toEqual([
      'evidenceRefs names "dnsRecords", which is not in the evidence',
    ]);
    expect(judge({ likelyCause: "It has been failing for 37 minutes." })).toEqual([
      '"37" is not in the evidence',
    ]);
    expect(
      judge({ likelyCause: "The upstream db-7.internal refuses connections." }).join(" | "),
    ).toMatch(/"db-7\.internal" is a host or address the evidence doesn't have/);
    expect(judge({ headline: "token sk_live_9f8a7b6c5d4e3f2a1b0c leaked" })).toContain(
      "the answer contains a secret",
    );
    expect(judge({ headline: "PWNED" })).toContain(
      "the answer followed an instruction hidden in the evidence",
    );
    expect(judge({ confidence: "certain" })[0]).toMatch(/^schema: confidence/);
  });
});
