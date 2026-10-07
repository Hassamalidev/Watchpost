/*
 * The eval fixtures against the real model (PRODUCT.md §9.10). Skipped unless both
 * ANTHROPIC_API_KEY and AI_EVAL_LIVE=1 are set, because it spends a few cents and needs the
 * network: run it by hand after changing a prompt or the model, never in CI.
 *
 *   AI_EVAL_LIVE=1 ANTHROPIC_API_KEY=… vitest run src/modules/ai/__tests__/evals.live.test.ts
 */
import { describe, expect, it } from "vitest";
import { createAnthropicClient } from "../../../infra/anthropic/index.js";
import { judgeExplanation } from "../evals/checks.js";
import { EXPLAINER_CASES } from "../evals/fixtures.js";
import { PROMPTS, promptSchema } from "../prompts.js";
import { redact } from "../redact.js";

const env = process.env;
const live = env.AI_EVAL_LIVE === "1" && (env.ANTHROPIC_API_KEY ?? "") !== "";

describe.skipIf(!live)("evals against the real model", () => {
  const client = createAnthropicClient({
    apiKey: env.ANTHROPIC_API_KEY ?? "",
    model: env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001",
  });

  for (const fixture of EXPLAINER_CASES) {
    it(`${fixture.name}`, async () => {
      const prompt = PROMPTS.explainer;
      const response = await client.complete({
        system: prompt.system,
        user: JSON.stringify(redact(fixture.evidence)),
        schema: promptSchema("explainer"),
        schemaName: prompt.schemaName,
        maxTokens: prompt.maxTokens,
        timeoutMs: 30_000,
      });
      process.stdout.write(`\n${fixture.name}\n${JSON.stringify(response.output, null, 2)}\n`);
      expect(judgeExplanation(fixture.evidence, response.output, fixture.secrets)).toEqual([]);
    }, 60_000);
  }
});
