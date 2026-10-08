/*
 * AI generations (PRODUCT.md §6.9, §9.10). One guarded path for every AI feature:
 *
 *   budget → circuit breaker → redact → call (8 s, one retry) → validate → meter → store
 *
 * AI is optional everywhere: a call that isn't allowed, fails or answers badly ends as a stored
 * "skipped" or "failed" row and the caller carries on without it. Nothing here ever throws to a
 * caller because the model misbehaved, and nothing here decides whether to alert.
 */
import type { AiFeedback, AiPostmortem, PostmortemView } from "@app/shared";
import type { Clock } from "../../core/clock.js";
import { ConflictError, NotFoundError } from "../../core/errors.js";
import { createWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import {
  AiError,
  aiCostMicros,
  type AiClient,
  type AiResponse,
} from "../../infra/anthropic/index.js";
import type { Logger } from "../../infra/logger.js";
import type { CreditsService } from "../credits/index.js";
import type { IncidentsService } from "../incidents/index.js";
import type { AiRepository } from "./ai.repository.js";
import {
  PROMPTS,
  promptSchema,
  type Prompt,
  type PromptKey,
  type PromptOutput,
} from "./prompts.js";
import { internalDetailIn, redact, scrubInternal } from "./redact.js";
import type { AiGenerationRow } from "./schema/ai.js";

/* Failures in a row that open the circuit, and how long it stays open (§9.10). */
export const BREAKER_FAILURES = 5;
export const BREAKER_OPEN_MS = 60_000;

export type SkipReason =
  "not_configured" | "disabled" | "budget_used" | "platform_cap" | "circuit_open";
export type FailReason = "timeout_or_provider" | "invalid_output" | "internal_detail";

export type Generated<T> =
  | { ok: true; generationId: string; output: T; model: string; createdAt: string; reused: boolean }
  | { ok: false; status: "skipped" | "failed"; reason: SkipReason | FailReason };

export interface GenerateInput<K extends PromptKey> {
  prompt: K;
  /* What the answer is about; with `once`, a stored answer about it is returned instead of asking again. */
  refId: string;
  /* Evidence for the model. Redacted here before it is sent, whatever the caller did. */
  evidence: Record<string, unknown>;
  /* For prompts whose answer is public: host names that are fine to show (the customer's own site). */
  allowedHosts?: readonly string[];
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
  /* The feedback a stored answer has now. */
  feedbackOf(scope: WorkspaceScope, generationId: string): Promise<AiFeedback | null>;
  /* 👍, 👎 or nothing on a stored answer. */
  feedback(
    scope: WorkspaceScope,
    generationId: string,
    feedback: AiFeedback | null,
  ): Promise<AiGenerationRow>;
  /* Whether AI can be used at all on this server (a key is set). */
  configured(): boolean;
  /*
   * The incident explainer (§6.9): explains one incident from its evidence and stores the answer
   * on it. Runs after the alert is already on its way; whatever happens here, the alert is not
   * affected. Returns what happened, for the log.
   */
  explainIncident(incidentId: string): Promise<"explained" | "already" | "skipped" | "failed">;
  /*
   * Drafts the incident's postmortem and saves it as the incident's review for a person to edit.
   * The model writes the judgement; times, durations and the timeline are printed from our own
   * record. Throws a conflict with the reason when no draft can be made.
   */
  draftPostmortem(scope: WorkspaceScope, ref: string | number): Promise<PostmortemView>;
}

export interface AiServiceDeps {
  repository: AiRepository;
  /* Undefined until the owner sets ANTHROPIC_API_KEY: every call is then skipped. */
  client: AiClient | undefined;
  credits: Pick<CreditsService, "aiBudget" | "recordUsage">;
  /* Optional so the generation path can be tested on its own. */
  incidents?:
    | Pick<IncidentsService, "aiEvidence" | "setAiSummary" | "postmortemSource" | "savePostmortem">
    | undefined;
  clock: Clock;
  logger: Logger;
  newId: () => string;
}

/* The draft as Markdown: our record's facts and timeline around the model's text. */
export function postmortemMarkdown(
  source: { number: number; title: string; facts: string[]; timeline: string[] },
  draft: AiPostmortem,
): string {
  const list = (items: string[]) =>
    items.length === 0 ? "- Nothing recorded." : items.map((item) => `- ${item}`).join("\n");
  return [
    `# Postmortem: ${source.title} (#${source.number})`,
    "",
    "_Drafted by AI from the incident record. Read it, correct it and fill the gaps before sharing._",
    "",
    "## Summary",
    draft.summary,
    "",
    "## Facts",
    list(source.facts),
    "",
    "## Impact",
    draft.impact,
    "",
    "## Root cause",
    draft.rootCause,
    "",
    "## Timeline",
    list(source.timeline),
    "",
    "## What went well",
    list(draft.whatWentWell),
    "",
    "## What went wrong",
    list(draft.whatWentWrong),
    "",
    "## Action items",
    list(draft.actionItems),
    "",
  ].join("\n");
}

export function createAiService(deps: AiServiceDeps): AiService {
  const { repository: repo, clock } = deps;
  /* One breaker for the provider: when it is failing, every workspace stops calling it for a while. */
  const breaker = { failures: 0, openUntil: 0 };

  async function callWithRetry(
    client: AiClient,
    request: Parameters<AiClient["complete"]>[0],
    retry: boolean,
  ): Promise<AiResponse> {
    try {
      return await client.complete(request);
    } catch (err) {
      if (!retry || !(err instanceof AiError) || !err.retryable) throw err;
      return client.complete(request);
    }
  }

  const service: AiService = {
    configured: () => deps.client !== undefined,

    async explainIncident(incidentId) {
      if (deps.incidents === undefined || deps.client === undefined) return "skipped";
      const found = await deps.incidents.aiEvidence(incidentId);
      if (found === undefined) return "skipped";
      /* Fire drills and expiry warnings explain themselves. */
      const source = found.evidence.source;
      if (source === "drill" || source === "expiry") return "skipped";
      const result = await service.generate(
        createWorkspaceScope({ workspaceId: found.workspaceId }),
        { prompt: "explainer", refId: incidentId, evidence: found.evidence, once: true },
      );
      if (!result.ok) return result.status;
      const stored = await deps.incidents.setAiSummary(incidentId, {
        ...result.output,
        generationId: result.generationId,
        model: result.model,
        createdAt: result.createdAt,
      });
      return stored ? "explained" : "already";
    },

    latest: (scope, prompt, refId) => repo.latestOk(scope, PROMPTS[prompt].key, refId),

    async generate(scope, input) {
      const prompt = PROMPTS[input.prompt];
      const settings: Prompt<unknown> = prompt;
      const isPublic = settings.public === true;
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
        response = await callWithRetry(
          client,
          {
            system: prompt.system,
            user: JSON.stringify(
              isPublic
                ? scrubInternal(redact(input.evidence), input.allowedHosts)
                : redact(input.evidence),
            ),
            schema: promptSchema(input.prompt),
            schemaName: prompt.schemaName,
            maxTokens: prompt.maxTokens,
            ...(settings.timeoutMs === undefined ? {} : { timeoutMs: settings.timeoutMs }),
          },
          settings.retry !== false,
        );
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
      /* Text for the public must not name an internal host or address, whatever the model did. */
      const leaked =
        parsed.success && isPublic
          ? Object.values(parsed.data as Record<string, unknown>)
              .filter((value): value is string => typeof value === "string")
              .map((text) => internalDetailIn(text, input.allowedHosts))
              .find((found) => found !== undefined)
          : undefined;
      const failure: FailReason | null = !parsed.success
        ? "invalid_output"
        : leaked !== undefined
          ? "internal_detail"
          : null;
      const row = await repo.insert(scope, {
        ...base,
        ...tokens,
        id: generationId,
        model: response.model,
        status: failure === null ? "ok" : "failed",
        reason: failure,
        output:
          failure === null && parsed.success ? (parsed.data as Record<string, unknown>) : null,
        createdAt: clock.now(),
      });
      if (!parsed.success || failure !== null) {
        deps.logger.warn(
          { kind: prompt.key, refId: input.refId, reason: failure },
          "AI answer refused",
        );
        return { ok: false, status: "failed", reason: failure ?? "invalid_output" };
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

    async draftPostmortem(scope, ref) {
      if (deps.incidents === undefined || deps.client === undefined) {
        throw new ConflictError("AI drafts aren't set up on this server.");
      }
      const source = await deps.incidents.postmortemSource(scope, ref);
      const result = await service.generate(scope, {
        prompt: "postmortem",
        refId: source.incidentId,
        evidence: source.evidence,
      });
      if (!result.ok) {
        throw new ConflictError(
          result.reason === "budget_used" || result.reason === "platform_cap"
            ? "This month's AI budget is used up. Write the postmortem yourself, or upgrade."
            : result.reason === "disabled"
              ? "AI is switched off at the moment."
              : "The AI service didn't produce a usable draft. Try again, or write it yourself.",
        );
      }
      return deps.incidents.savePostmortem(scope, ref, {
        markdown: postmortemMarkdown(source, result.output),
        aiGenerationId: result.generationId,
      });
    },

    async feedbackOf(scope, generationId) {
      const row = await repo.find(scope, generationId);
      if (row === undefined) throw new NotFoundError("AI answer not found.");
      return row.feedback;
    },

    async feedback(scope, generationId, feedback) {
      const row = await repo.setFeedback(scope, generationId, feedback, scope.actorUserId ?? null);
      if (row === undefined) throw new NotFoundError("AI answer not found.");
      return row;
    },
  };
  return service;
}
