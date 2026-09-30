import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

/* Loading the full flat config (typescript-eslint) is slow when Turbo runs packages in parallel. */
const LOAD_TIMEOUT_MS = 30_000;

describe("repo ESLint config", () => {
  it("fails a TypeScript file that uses a // comment", { timeout: LOAD_TIMEOUT_MS }, async () => {
    const eslint = new ESLint({ cwd: root });
    const [result] = await eslint.lintText("// not allowed\nexport const a = 1;\n", {
      filePath: `${root}packages/shared/src/sample.ts`,
    });
    expect(result?.messages.map((m) => m.ruleId)).toContain("local/no-line-comments");
  });
});
