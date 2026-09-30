import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import { noLineComments } from "../no-line-comments.js";

RuleTester.describe = describe;
RuleTester.it = it;

new RuleTester().run("no-line-comments", noLineComments, {
  valid: [
    "/* block comment */ const a = 1;",
    'const url = "https://example.com";',
    '/// <reference types="node" />\nconst b = 2;',
  ],
  invalid: [
    { code: "// line comment\nconst a = 1;", errors: [{ messageId: "lineComment" }] },
    { code: "const a = 1; // trailing", errors: [{ messageId: "lineComment" }] },
    { code: "// eslint-disable-next-line\nconst a = 1;", errors: [{ messageId: "lineComment" }] },
  ],
});
