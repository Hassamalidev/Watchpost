/*
 * Claude behind an adapter (PRODUCT.md §7.1 rule 12, §9.10). Every AI feature asks for one thing: a
 * JSON object that fits a schema. The model is made to answer through a tool call, so the answer is
 * structured by construction and still validated by the caller.
 *
 * This talks to the Messages API over HTTPS directly. STACK.md names the official SDK; it could not
 * be installed when this was written (D-094) and nothing here needs more than one POST. Swapping the
 * SDK in later changes only `createAnthropicClient`.
 */
export const ANTHROPIC_API = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";
/* §9.10: an AI call that takes longer than this is given up on. */
export const AI_TIMEOUT_MS = 8_000;

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  /* Input tokens read from, and written to, the prompt cache. */
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AiRequest {
  /* Fixed instructions; cached by the provider across calls. */
  system: string;
  /* The evidence for this call, already redacted. */
  user: string;
  /* The shape of the answer, as JSON Schema. */
  schema: Record<string, unknown>;
  /* A short name for the answer ("incident_explanation"). */
  schemaName: string;
  maxTokens: number;
  timeoutMs?: number;
}

export interface AiResponse {
  /* The model's answer; the caller validates it. */
  output: unknown;
  usage: AiUsage;
  model: string;
}

export interface AiClient {
  readonly model: string;
  complete(request: AiRequest): Promise<AiResponse>;
}

/* `retryable`: a timeout, a rate limit or a server error; anything else won't work on a retry. */
export class AiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AiError";
  }
}

/*
 * USD per million tokens, in micro-USD per token. From Anthropic's price list for Claude Haiku 4.5
 * when this was written: $1 input, $5 output, cache reads at a tenth and cache writes at 1.25 times
 * the input price. Check the list when the model changes.
 */
export const AI_PRICE_MICROS_PER_TOKEN = {
  input: 1,
  output: 5,
  cacheRead: 0.1,
  cacheWrite: 1.25,
} as const;

export function aiCostMicros(usage: AiUsage): number {
  const p = AI_PRICE_MICROS_PER_TOKEN;
  return Math.ceil(
    usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.cacheWrite,
  );
}

interface MessagesResponse {
  model?: string;
  content?: Array<{ type?: string; input?: unknown }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

export function createAnthropicClient(options: {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
}): AiClient {
  const send = options.fetch ?? fetch;
  return {
    model: options.model,
    async complete(request) {
      let res: Response;
      try {
        res = await send(`${ANTHROPIC_API}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": options.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          body: JSON.stringify({
            model: options.model,
            max_tokens: request.maxTokens,
            system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: request.user }],
            tools: [
              {
                name: request.schemaName,
                description: "Give the answer in this shape.",
                input_schema: request.schema,
              },
            ],
            tool_choice: { type: "tool", name: request.schemaName },
          }),
          signal: AbortSignal.timeout(request.timeoutMs ?? AI_TIMEOUT_MS),
        });
      } catch (err) {
        const timedOut = err instanceof Error && err.name === "TimeoutError";
        throw new AiError(timedOut ? "The AI call timed out." : "The AI call failed.", true);
      }
      if (!res.ok) {
        /* The body may echo the prompt; only the status is kept. */
        throw new AiError(
          `The AI provider answered HTTP ${res.status}.`,
          res.status === 429 || res.status >= 500,
        );
      }
      const body = (await res.json().catch(() => null)) as MessagesResponse | null;
      const answer = body?.content?.find((block) => block.type === "tool_use");
      if (answer === undefined) throw new AiError("The AI answer had no structured part.", false);
      return {
        output: answer.input,
        model: body?.model ?? options.model,
        usage: {
          inputTokens: body?.usage?.input_tokens ?? 0,
          outputTokens: body?.usage?.output_tokens ?? 0,
          cacheReadTokens: body?.usage?.cache_read_input_tokens ?? 0,
          cacheWriteTokens: body?.usage?.cache_creation_input_tokens ?? 0,
        },
      };
    },
  };
}

/* For tests and evals: answers from a function and records what it was asked. */
export function createFakeAiClient(
  answer: (request: AiRequest) => unknown,
  usage: Partial<AiUsage> = {},
): AiClient & { requests: AiRequest[] } {
  const requests: AiRequest[] = [];
  return {
    model: "fake-model",
    requests,
    async complete(request) {
      requests.push(request);
      const output = await answer(request);
      return {
        output,
        model: "fake-model",
        usage: {
          inputTokens: 1_200,
          outputTokens: 180,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          ...usage,
        },
      };
    },
  };
}
