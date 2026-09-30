/* Local ESLint rules for this repo. */
import { noLineComments } from "./no-line-comments.js";

export default {
  meta: { name: "@app/eslint-plugin" },
  rules: { "no-line-comments": noLineComments },
};
