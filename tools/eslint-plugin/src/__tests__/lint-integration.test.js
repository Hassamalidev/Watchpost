import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

describe("repo ESLint config", () => {
  it("fails a TypeScript file that uses a // comment", async () => {
    const eslint = new ESLint({ cwd: root });
    const [result] = await eslint.lintText("// not allowed\nexport const a = 1;\n", {
      filePath: `${root}packages/shared/src/sample.ts`,
    });
    expect(result?.messages.map((m) => m.ruleId)).toContain("local/no-line-comments");
  });
});
