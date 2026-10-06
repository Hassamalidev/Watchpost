/* The web app (backend/web) is its own package with its own Vitest config. */
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "web/**", "dist/**", ".arch-selftest/**"],
    globalSetup: ["./src/__tests__/helpers/global-setup.ts"],
    /*
     * Test files share one Postgres database and one outbox table (the relay claims every
     * undispatched row), so files run one at a time; tests inside a file are already sequential.
     */
    fileParallelism: false,
  },
});
