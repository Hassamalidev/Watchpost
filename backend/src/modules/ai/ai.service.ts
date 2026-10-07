/*
 * AI generations (PRODUCT.md §6.9, §9.10). One guarded path for every AI feature:
 *
 *   budget → circuit breaker → redact → call (8 s, one retry) → validate → meter → store
 *
 * AI is optional everywhere: a call that isn't allowed, fails or answers badly ends as a stored
 * "skipped" or "failed" row and the caller carries on without it. Nothing here ever throws to a
 * caller because the model misbehaved, and nothing here decides whether to alert.
 */
import type { AiFeedback } from "@app/shared";
import type { Clock } from "../../core/clock.js";
import { NotFoundError } from "../../core/errors.js";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import {
  AiError,
  aiCostMicros,
  type AiClient,
  type AiResponse,
} from "../../infra/anthropic/index.js";
import type { Logger } from "../../infra/logger.js";
import type { CreditsService } from "../credits/index.js";
import type { AiRepository } from "./ai.repository.js";
import { PROMPTS, promptSchema, type PromptKey, type PromptOutput } from "./prompts.js";
import { redact } from "./redact.js";
import type { AiGenerationRow } from "./schema/ai.js";

/* Failures in a row that open the circuit, and how long it stays open (§9.10). */
export const BREAKER_FAILURES = 5;
export const BREAKER_OPEN_MS = 60_000;

export type SkipReason =
  "not_configured" | "disabled" | "budget_used" | "platform_cap" | "circuit_open";
export type FailReason = "timeout_or_provider" | "invalid_output";

export type Generated<T> =
  | { ok: true; generationId: string; output: T; model: string; createdAt: string; reused: boolean }
  | { ok: false; status: "skipped" | "failed"; reason: SkipReason | FailReason };

export interface GenerateInput<K extends PromptKey> {
  prompt: K;
  /* What the answer is about; with `once`, a stored answer about it is returned instead of asking again. */
  refId: string;
  /* Evidence for the model. Redacted here before it is sent, whatever the caller did. */
  evidence: Record<string, unknown>;
  once?: boolean;
}

export interface AiService {
  generate<K extends PromptKey>(
    scope: WorkspaceScope,
    input: GenerateInput<K>,
  ): Promise<Generated<PromptOutput<K>>>;
  /* The newest stored answer of a kind about one thing. */
  latest(
    scope: WorkspaceScope,
    prompt: PromptKey,
    refId: string,
  ): Promise<AiGenerationRow | undefined>;
  /* 👍, 👎 or nothing on a stored answer. */
  feedback(
    scope: WorkspaceScope,
    generationId: string,
    feedback: AiFeedback | null,
  ): Promise<AiGenerationRow>;
  /* Whether AI can be used at all on this server (a key is set). */
  configured(): boolean;
}

export interface AiServiceDeps {
  repository: AiRepository;
  /* Undefined until the owner sets ANTHROPIC_API_KEY: every call is then skipped. */
  client: AiClient | undefined;
  credits: Pick<CreditsService, "aiBudget" | "recordUsage">;
  clock: Clock;
  logger: Logger;
  newId: () => string;
}

export function createAiService(deps: AiServiceDeps): AiService {
  const { repository: repo, clock } = deps;
  /* One breaker for the provider: when it is failing, every workspace stops calling it for a while. */
  const breaker = { failures: 0, openUntil: 0 };

  async function callWithRetry(
    client: AiClient,
    request: Parameters<AiClient["complete"]>[0],
  ): Promise<AiResponse> {
    try {
      return await client.complete(request);
    } catch (err) {
      if (!(err instanceof AiError) || !err.retryable) throw err;
      return client.complete(request);
    }
  }

  return {
    configured: () => deps.client !== undefined,

    latest: (scope, prompt, refId) => repo.latestOk(scope, PROMPTS[prompt].key, refId),

    async generate(scope, input) {
      const prompt = PROMPTS[input.prompt];
      if (input.once === true) {
        const existing = await repo.latestOk(scope, prompt.key, input.refId);
        if (existing !== undefined && existing.output !== null) {
          return {
            ok: true,
            generationId: existing.id,
            output: existing.output as PromptOutput<typeof input.prompt>,
            model: existing.model ?? "",
            createdAt: existing.createdAt.toISOString(),
            reused: true,
          };
        }
      }

      const base = {
        kind: prompt.key,
        promptVersion: prompt.version,
        refId: input.refId,
        inputTokens: 0,
        outputTokens: 0,
        costMicros: 0,
        output: null,
      };
      const skip = async (reason: SkipReason) => {
        await repo.insert(scope, {
          ...base,
          id: deps.newId(),
          model: null,
          status: "skipped",
          reason,
          createdAt: clock.now(),
        });
        return { ok: false as const, status: "skipped" as const, reason };
      };

      const client = deps.client;
      if (client === undefined) return { ok: false, status: "skipped", reason: "not_configured" };
      const budget = await deps.credits.aiBudget(scope);
      if (!budget.allowed) return skip(budget.reason === "ok" ? "budget_used" : budget.reason);
      if (breaker.openUntil > clock.now().getTime()) return skip("circuit_open");

      const generationId = deps.newId();
      let response: AiResponse;
      try {
        response = await callWithRetry(client, {
          system: prompt.system,
          user: JSON.stringify(redact(input.evidence)),
          schema: promptSchema(input.prompt),
          schemaName: prompt.schemaName,
          maxTokens: prompt.maxTokens,
        });
        breaker.failures = 0;
      } catch (err) {
        breaker.failures += 1;
        if (breaker.failures >= BREAKER_FAILURES) {
          breaker.openUntil = clock.now().getTime() + BREAKER_OPEN_MS;
          breaker.failures = 0;
          deps.logger.warn({ openForMs: BREAKER_OPEN_MS }, "AI circuit breaker opened");
        }
        deps.logger.warn(
          {
            kind: prompt.key,
            refId: input.refId,
            err: err instanceof Error ? err.message : "error",
          },
          "AI call failed",
        );
        await repo.insert(scope, {
          ...base,
          id: generationId,
          model: client.model,
          status: "failed",
          reason: "timeout_or_provider",
          createdAt: clock.now(),
        });
        return { ok: false, status: "failed", reason: "timeout_or_provider" };
      }

      /* The tokens were used whatever the answer is worth: meter first. */
      const costMicros = aiCostMicros(response.usage);
      const tokens = {
        inputTokens:
          response.usage.inputTokens +
          response.usage.cacheReadTokens +
          response.usage.cacheWriteTokens,
        outputTokens: response.usage.outputTokens,
        costMicros,
      };
      await deps.credits.recordUsage(scope, {
        provider: "anthropic",
        kind: prompt.key,
        units: tokens.inputTokens + tokens.outputTokens,
        costMicros,
        ref: generationId,
      });

      const parsed = prompt.output.safeParse(response.output);
      const row = await repo.insert(scope, {
        ...base,
        ...tokens,
        id: generationId,
        model: response.model,
        status: parsed.success ? "ok" : "failed",
        reason: parsed.success ? null : "invalid_output",
        output: parsed.success ? (parsed.data as Record<string, unknown>) : null,
        createdAt: clock.now(),
      });
      if (!parsed.success) {
        deps.logger.warn(
          { kind: prompt.key, refId: input.refId },
          "AI answer didn't fit its schema",
        );
        return { ok: false, status: "failed", reason: "invalid_output" };
      }
      return {
        ok: true,
        generationId,
        output: parsed.data as PromptOutput<typeof input.prompt>,
        model: response.model,
        createdAt: row.createdAt.toISOString(),
        reused: false,
      };
    },

    async feedback(scope, generationId, feedback) {
      const row = await repo.setFeedback(scope, generationId, feedback, scope.actorUserId ?? null);
      if (row === undefined) throw new NotFoundError("AI answer not found.");
      return row;
    },
  };
}
