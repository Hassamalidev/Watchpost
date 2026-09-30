/* Root Vitest config: lets `vitest` at the repo root (and editors) see every package's tests. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "tools/*"],
  },
});
