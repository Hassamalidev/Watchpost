/*
 * Bans `//` line comments (STACK.md §5: block comments only).
 * Triple-slash directives such as `/// <reference types="..." />` stay allowed,
 * because tools like Next.js generate them.
 */

const DIRECTIVE = /^\/\s*<(reference|amd-module|amd-dependency)\b/;

/** @type {import("eslint").Rule.RuleModule} */
export const noLineComments = {
  meta: {
    type: "suggestion",
    docs: { description: "Disallow // line comments; use /* */ block comments" },
    messages: { lineComment: "Use a /* */ block comment instead of //." },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type !== "Line" || DIRECTIVE.test(comment.value)) continue;
          context.report({ loc: comment.loc ?? { line: 1, column: 0 }, messageId: "lineComment" });
        }
      },
    };
  },
};
